#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch-vendor.py —— 拉取并准备邮箱界面所需的第三方运行时

背景：
    桌面端的「邮箱」界面使用成熟开源组件 SnappyMail（AGPL-3.0），
    它由 PHP 编写，因此需要随包分发一个便携版 PHP 运行时。
    这两个组件体积较大（合计约 58MB），不入 git，改由本脚本按需拉取。

本脚本做的事（可重复执行，幂等）：
    1. 下载 Windows 便携版 PHP（NTS x64）           —— PHP License v3.01
    2. 下载 SnappyMail 官方 release 包               —— AGPL-3.0
    3. 解压到 vendor/php 与 vendor/snappymail
    4. 裁剪 PHP：只保留实际用到的扩展与依赖 DLL（约 92MB → 44MB）
    5. 生成 php.ini / router.php / include.php（数据目录重定向）

用法：
    python scripts/fetch-vendor.py

注意：
    生成物中含有第三方许可证文件（vendor/php/license.txt、
    vendor/php/readme-redist-bins.txt、vendor/snappymail/LICENSE），请勿删除。
"""

import io
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
import zipfile

# 仓库内维护的 SnappyMail 定制层应用器（Windows / macOS 共用）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from email_overlay import apply_overlay as _apply_overlay  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENDOR = os.path.join(ROOT, "vendor")
DL = os.path.join(VENDOR, "_dl")
# 仓库内维护的 SnappyMail 定制层（UI 主题注入 / 插件 / 域名配置），入 git
OVERLAY = os.path.join(ROOT, "email-overlay")

# 优先用这个版本；官方 releases 目录只留最近几个小版本，下架后自动
# 回退到目录里最新的 8.4.x（见 discover_latest_php）。绝不让脚本因为
# 某个小版本消失就再也拉不到运行时。
PHP_VERSION = "8.4.27"
PHP_ZIP_TPL = "php-{}-nts-Win32-vs17-x64.zip"
PHP_DIRS = [
    "https://downloads.php.net/~windows/releases/",
    "https://windows.php.net/downloads/releases/",
]
UA = "mylog-fetch-vendor"

SNAPPY_VERSION = "2.38.2"
SNAPPY_ZIP = "snappymail-{}.zip".format(SNAPPY_VERSION)
SNAPPY_BASE = "https://github.com/the-djmaze/snappymail/releases/download/v{}/".format(SNAPPY_VERSION)
# 直连不通时按序回退到公共加速通道
SNAPPY_URLS = [
    SNAPPY_BASE + SNAPPY_ZIP,
    "https://ghproxy.net/" + SNAPPY_BASE + SNAPPY_ZIP,
    "https://gh-proxy.com/" + SNAPPY_BASE + SNAPPY_ZIP,
    "https://ghfast.top/" + SNAPPY_BASE + SNAPPY_ZIP,
]

# 保留的 PHP 扩展（其余在裁剪阶段删除）
KEEP_EXT = {
    "php_mbstring.dll",   # 必需：SnappyMail 全程使用 mb_* 处理 UTF-8
    "php_openssl.dll",    # 必需：IMAP/SMTP 的 TLS 加密
    "php_sodium.dll",     # 必需：本地保存的账号口令走 sodium 加密
    "php_curl.dll",       # OAuth2 登录（如 Gmail）与插件
    "php_sockets.dll",    # 连通性/性能
    "php_zip.dll",        # 多附件打包下载
    "php_fileinfo.dll",   # 附件类型识别
    "php_gd.dll",         # 图片缩放（头像/缩略图）
    "php_exif.dll",       # 图片方向
    "php_pdo_sqlite.dll", # 通讯录存储
    "php_sqlite3.dll",
    "php_opcache.dll",    # 性能
}

# 保留的顶层依赖 DLL（其余删除；已用 deplister 逐一核对过依赖关系）
KEEP_DLL = {
    "libcrypto-3-x64.dll", "libssl-3-x64.dll",   # openssl
    "libssh2.dll", "nghttp2.dll",                # curl
    "brotlicommon.dll", "brotlidec.dll",         # curl 的 brotli 解压
    "libsodium.dll",                             # sodium
    "libsqlite3.dll",                            # sqlite
}

KEEP_TOP = {
    "php.exe", "php8.dll", "php.ini", "router.php",
    "license.txt",              # PHP 许可（合规必需）
    "readme-redist-bins.txt",   # PHP 所捆绑的第三方组件声明（合规必需）
    "cacert.pem",               # TLS 根证书（IMAP/SMTP over SSL 必须，见 PHP_INI）
}

# TLS 根证书包（Mozilla CA bundle）。缺它会导致连 imap.qiye.aliyun.com:993
# 时 cURL/OpenSSL 校验失败，表现为「无法连接至服务器」。
CACERT_URLS = [
    "https://curl.se/ca/cacert.pem",
    "https://raw.githubusercontent.com/bagder/ca-bundle/master/ca-bundle.crt",
]

PHP_INI_TEMPLATE = r"""; 由 scripts/fetch-vendor.py 生成，请勿手工修改（改动会被覆盖）
; e日志 桌面端内置 PHP 运行时（NTS x64，__PHP_VER__）

[PHP]
extension_dir = "ext"

default_charset = "UTF-8"
output_buffering = 4096
date.timezone = "Asia/Shanghai"
memory_limit = 256M
max_execution_time = 120
max_input_time = 120
upload_max_filesize = 64M
post_max_size = 64M
max_file_uploads = 20

display_errors = Off
display_startup_errors = Off
log_errors = On
error_reporting = E_ALL & ~E_DEPRECATED & ~E_NOTICE & ~E_WARNING

session.use_strict_mode = 1
session.cookie_httponly = 1
session.use_only_cookies = 1

expose_php = Off
cgi.fix_pathinfo = 1

; 不做函数禁用：SnappyMail 的配置加载依赖 parse_ini_file()，PGP/插件会用到
; exec / proc_open。本进程只监听 127.0.0.1，仅供本机桌面端使用。
disable_functions =

; ── 扩展 ──
; intl 不装：SnappyMail 仅用它做 IDN（中文域名）转换，其自带
; SnappyMail\Intl\Idn（Symfony UTS#46 实现）会作为 polyfill 接管，可省约 38MB。
extension=mbstring
extension=openssl
extension=curl
extension=sockets
extension=zip
extension=fileinfo
extension=sodium
extension=gd
extension=exif
extension=pdo_sqlite
extension=sqlite3
; ctype / tokenizer / session / iconv 在 PHP 8.4 Windows 版中为内置模块，
; 用 extension= 加载会报 "Unable to load dynamic library"。

; ── TLS 根证书（IMAP/SMTP over SSL 与 curl HTTPS 校验）──
; 随包附带 Mozilla 根证书包，不依赖目标机器的证书库。
; 路径相对 PHP 进程工作目录（主进程 spawn 时 cwd = vendor 根目录）。
openssl.cafile = "php/cacert.pem"
curl.cainfo = "php/cacert.pem"

; ── opcache（Zend 扩展，必须用 zend_extension）──
; 【勿改】enable / enable_cli 必须保持 0。
; 开启后部分 Windows 环境（尤其父进程不是普通 shell 时）会直接致命错误
; 「Opcode handlers are unusable due to ASLR」→ 进程立刻退出 → php -S 起不来
; → 邮箱窗口空白 /「邮箱服务启动超时」。本地单用户 webmail 关掉只多几毫秒。
zend_extension=opcache
opcache.enable = 0
opcache.enable_cli = 0
opcache.memory_consumption = 128
opcache.interned_strings_buffer = 16
opcache.max_accelerated_files = 10000
opcache.validate_timestamps = 1
opcache.revalidate_freq = 60
"""


def php_ini(ver):
    return PHP_INI_TEMPLATE.replace("__PHP_VER__", ver)


ROUTER_PHP = r"""<?php
/**
 * e日志 桌面端内置 PHP 路由（模拟 Apache .htaccess 重写）
 * 由 scripts/fetch-vendor.py 生成。
 */

$root = $_SERVER['DOCUMENT_ROOT'];
$uri  = urldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH));

if (strpos($uri, '..') !== false) {
    http_response_code(400);
    exit('Bad Request');
}

$file = realpath($root . $uri);

// 已存在的静态文件 → 交给内置服务器直接返回
if ($uri !== '/' && $file && is_file($file) && strpos($file, realpath($root)) === 0) {
    return false;
}

require $root . '/index.php';
"""

SNAPPY_INCLUDE_PHP = r"""<?php

/**
 * e日志 桌面端 · SnappyMail 数据目录重定向
 * 由 scripts/fetch-vendor.py 生成。
 *
 * 安装目录对普通用户只读，而 SnappyMail 运行期要写配置/缓存/会话/通讯录，
 * 因此把数据目录指向 Electron 的 userData。
 * 目录由主进程经环境变量 MYLOG_EMAIL_DATA 传入（见 lib/phpServer.js）。
 */

function __get_custom_data_full_path()
{
	$p = getenv('MYLOG_EMAIL_DATA');
	if ($p && is_dir($p)) {
		return rtrim($p, "\\/");
	}
	return '';
}
"""


def log(msg):
    print(msg, flush=True)


def download(urls, target, label, min_size=1024 * 1024):
    """按序尝试多个地址下载；支持断点重试。"""
    if os.path.exists(target) and os.path.getsize(target) > min_size:
        log("  [跳过] {} 已存在 ({:.1f} MB)".format(label, os.path.getsize(target) / 1048576))
        return True
    for i, url in enumerate(urls, 1):
        log("  [下载] {} ({}/{})".format(label, i, len(urls)))
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "mylog-fetch-vendor"})
            with urllib.request.urlopen(req, timeout=180) as resp, open(target, "wb") as out:
                shutil.copyfileobj(resp, out, 1024 * 256)
            size = os.path.getsize(target)
            if size > min_size:
                log("         OK {:.1f} KB".format(size / 1024))
                return True
            log("         文件过小，换下一个源")
        except Exception as e:
            log("         失败：{}".format(e))
        try:
            os.remove(target)
        except OSError:
            pass
    return False


def extract_zip(zip_path, dest, strip_top=False):
    if os.path.isdir(dest):
        shutil.rmtree(dest, ignore_errors=True)
    os.makedirs(dest, exist_ok=True)
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        top = names[0].split("/")[0] if strip_top else None
        for n in names:
            rel = n
            if top and n.startswith(top + "/"):
                rel = n[len(top) + 1:]
            if not rel or rel.endswith("/"):
                continue
            target = os.path.join(dest, *rel.split("/"))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with z.open(n) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)


def trim_php(php_dir):
    """删掉用不到的扩展与 DLL，把 92MB 收到约 44MB。"""
    ext_dir = os.path.join(php_dir, "ext")
    if os.path.isdir(ext_dir):
        for f in os.listdir(ext_dir):
            if f not in KEEP_EXT:
                try:
                    os.remove(os.path.join(ext_dir, f))
                except OSError:
                    pass
    for f in os.listdir(php_dir):
        # 【勿删】ext 目录存放全部扩展 DLL。它本身要被保留，只裁里面内容
        # （裁剪在上面做）。早期版本漏了这个 continue，把整个 ext 删掉，
        # 导致包里 PHP 无任何扩展 → SnappyMail 报
        # "[302] The following PHP extensions are not available"，
        # 而探活要求响应体 >500 字节，于是表现为「邮箱服务启动超时」。
        if f == "ext":
            continue
        p = os.path.join(php_dir, f)
        if os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)
            continue
        if f in KEEP_TOP:
            continue
        if f.lower().endswith(".dll") and f in KEEP_DLL:
            continue
        try:
            os.remove(p)
        except OSError:
            pass


def dir_size_mb(d):
    total = 0
    for r, _, fs in os.walk(d):
        for f in fs:
            try:
                total += os.path.getsize(os.path.join(r, f))
            except OSError:
                pass
    return total / 1048576


def apply_overlay(snap_ver):
    """薄包装：真正实现见 scripts/email_overlay.py（macOS 脚本共用同一份）。"""
    ok, _ = _apply_overlay(ROOT, VENDOR, snap_ver, log)
    return ok


def verify_vendor(php_dir):
    """产物自检：缺任何一项都直接失败，不要靠安装包事后才发现。

    历史事故：trim_php 曾把整个 ext/ 删掉，CI 仍然绿，用户装完才看到
    「邮箱服务启动超时（端口 x 无响应）」。这里把上线前必须成立的
    条件全部断言一遍。
    """
    problems = []
    ext_dir = os.path.join(php_dir, "ext")
    if not os.path.isdir(ext_dir):
        problems.append("缺少 ext 目录（php.ini 里 extension= 全部失效）")
    else:
        for dll in sorted(KEEP_EXT):
            if not os.path.isfile(os.path.join(ext_dir, dll)):
                problems.append("缺少扩展 " + dll)
    for name in ("php.exe", "php8.dll", "cacert.pem"):
        if not os.path.isfile(os.path.join(php_dir, name)):
            problems.append("缺少 " + name)
    for name in ("php.ini", "router.php"):
        if not os.path.isfile(os.path.join(php_dir, name)):
            problems.append("缺少 " + name)

    if problems:
        for p in problems:
            log("  [自检失败] " + p)
        return False
    log("  文件齐全：ext {} 个扩展 + cacert.pem".format(len(KEEP_EXT)))

    # 真跑一次 php -m：文件在但依赖 DLL 缺失时扩展仍会加载失败，
    # 只有实际加载一遍才能证明这份运行时可用。
    php_exe = os.path.join(php_dir, "php.exe" if os.name == "nt" else "php")
    if not os.path.isfile(php_exe):
        log("  [跳过] 本机无法执行 PHP（非 Windows 或无 php.exe），仅做了文件检查")
        return True
    try:
        r = subprocess.run(
            [php_exe, "-c", os.path.join(php_dir, "php.ini"), "-m"],
            cwd=VENDOR, capture_output=True, text=True, timeout=90,
        )
    except Exception as e:
        log("  [自检失败] 无法执行 php -m：{}".format(e))
        return False
    mods = set()
    for line in (r.stdout or "").splitlines():
        t = line.strip().lower()
        if t and not t.startswith("["):
            mods.add(t)
    missing = [e for e in ("mbstring", "openssl", "sodium", "curl", "zip",
                           "fileinfo", "sockets", "pdo_sqlite", "sqlite3", "gd")
               if e not in mods]
    if missing:
        log("  [自检失败] php -m 缺少扩展：{}".format(", ".join(missing)))
        log("  php 输出：{}".format((r.stdout or "")[:600]))
        return False
    log("  php -m 通过：{} 个模块（含 mbstring/openssl/sodium/pdo_sqlite/sqlite3）".format(len(mods)))
    return True


def verify_snappymail():
    """SnappyMail 定制层自检：overlay 是否真的落上了。

    这几项丢了不会让 PHP 起不来，但用户会看到「原版界面」或「无法连接服务器」，
    而构建照样是绿的 —— 所以必须单独断言。
    """
    snap = os.path.join(VENDOR, "snappymail")
    problems = []

    idx = os.path.join(snap, "snappymail", "v", SNAPPY_VERSION, "app", "templates", "Index.html")
    if not os.path.isfile(idx):
        problems.append("缺少 SnappyMail 模板：" + idx)
    else:
        html = io.open(idx, encoding="utf-8", errors="replace").read()
        if "eb-mail-theme" not in html:
            problems.append("Index.html 里没有 eb-mail-theme 注入层（邮箱会显示原版界面）")
        else:
            log("  UI 注入层 OK：Index.html {:.1f} KB 含 eb-mail-theme".format(len(html) / 1024))

    for rel in ("plugins/mylog-provider/index.php",
                "plugins/mylog-provider/providers.php",
                "plugins/mylog-provider/mylog-provider.js",
                "data/_data_/_default_/configs/application.ini",
                "data/_data_/_default_/domains/default.json",
                "data/_data_/_default_/domains/disabled"):
        if not os.path.isfile(os.path.join(snap, *rel.split("/"))):
            problems.append("缺少 " + rel + "（插件或阿里邮箱域名配置没落上）")

    if problems:
        for p in problems:
            log("  [自检失败] " + p)
        return False
    log("  SnappyMail 定制层 OK：UI 注入 + mylog-provider 插件 + 阿里域名配置")
    return True


def discover_latest_php():
    """抓官方 releases 目录，返回其中最新的 8.4.x（拿不到返回 None）。"""
    pat = re.compile(r"php-(8\.4\.\d+)-nts-Win32-vs17-x64\.zip")
    best = None
    for d in PHP_DIRS:
        try:
            req = urllib.request.Request(d, headers={"User-Agent": UA})
            html = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")
        except Exception as e:
            log("  探测 {} 失败：{}".format(d, e))
            continue
        for v in pat.findall(html):
            key = tuple(int(x) for x in v.split("."))
            if best is None or key > tuple(int(x) for x in best.split(".")):
                best = v
    return best


def fetch_php():
    """下载便携 PHP，返回 (版本, zip 路径)；彻底失败返回 (None, None)。"""
    ver = PHP_VERSION
    for attempt in (1, 2):
        zip_name = PHP_ZIP_TPL.format(ver)
        target = os.path.join(DL, zip_name)
        urls = [d + zip_name for d in PHP_DIRS]
        if download(urls, target, "PHP " + ver):
            return ver, target
        if attempt == 1:
            latest = discover_latest_php()
            if latest and latest != ver:
                log("  {} 已下架，改用目录里最新的 8.4.x：{}".format(ver, latest))
                ver = latest
                continue
        break
    return None, None


def main():
    os.makedirs(DL, exist_ok=True)

    log("== 1/6 下载便携版 PHP（PHP License v3.01）")
    php_ver, php_zip = fetch_php()
    if not php_zip:
        log("PHP 下载失败，请检查网络后重试。")
        return 1

    log("== 2/6 下载 SnappyMail {}（AGPL-3.0）".format(SNAPPY_VERSION))
    snap_zip = os.path.join(DL, SNAPPY_ZIP)
    if not download(SNAPPY_URLS, snap_zip, "SnappyMail " + SNAPPY_VERSION):
        log("SnappyMail 下载失败，请检查网络后重试。")
        return 1

    log("== 3/6 解压")
    php_dir = os.path.join(VENDOR, "php")
    snap_dir = os.path.join(VENDOR, "snappymail")
    extract_zip(php_zip, php_dir)
    log("  PHP -> vendor/php")
    extract_zip(snap_zip, snap_dir)
    log("  SnappyMail -> vendor/snappymail")

    log("== 4/6 裁剪与配置 PHP")
    trim_php(php_dir)
    with open(os.path.join(php_dir, "php.ini"), "w", encoding="utf-8", newline="\n") as f:
        f.write(php_ini(php_ver))
    with open(os.path.join(php_dir, "router.php"), "w", encoding="utf-8", newline="\n") as f:
        f.write(ROUTER_PHP)
    with open(os.path.join(snap_dir, "include.php"), "w", encoding="utf-8", newline="\n") as f:
        f.write(SNAPPY_INCLUDE_PHP)

    log("== 5/6 应用 email-overlay（邮箱 UI / 插件 / 域名配置）")
    apply_overlay(SNAPPY_VERSION)

    # CA 根证书（约 220KB，故 min_size 用小阈值）
    cacert = os.path.join(php_dir, "cacert.pem")
    if not download(CACERT_URLS, cacert, "Mozilla CA 根证书", min_size=100 * 1024):
        log("CA 根证书下载失败：IMAP over SSL 将无法校验证书。请检查网络后重试。")
        return 1

    log("== 6/6 自检")
    ok_php = verify_vendor(php_dir)
    ok_snap = verify_snappymail()
    if not (ok_php and ok_snap):
        log("产物不完整，已中止（不要用它打包）。")
        return 1

    shutil.rmtree(DL, ignore_errors=True)

    log("")
    log("完成：vendor/php {:.1f} MB + vendor/snappymail {:.1f} MB".format(
        dir_size_mb(php_dir), dir_size_mb(snap_dir)))
    log("下一步：node --check main.js && npm run pack")
    return 0


if __name__ == "__main__":
    sys.exit(main())
