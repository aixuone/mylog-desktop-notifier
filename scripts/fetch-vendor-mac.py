#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch-vendor-mac.py —— 拉取 macOS 版邮箱运行时（静态 PHP + SnappyMail）

背景：
    Windows 那份 vendor/php 是 php.exe + DLL，macOS 上跑不了。
    macOS 要用「静态编译」的 PHP：单个可执行文件，不依赖系统里任何 dylib，
    也不需要用户装 PHP。来源是 static-php-cli 的 bulk 预编译包
    （dl.static-php.dev，与官方 spc 工具同源）。

    注意：这里的 PHP 版本（8.4.23）与 Windows 那份（8.4.26）不完全一致，
    因为 bulk 预编译只到 8.4.23。功能上无差异，不必强行对齐。

产物：
    vendor/php-mac/bin/php-arm64      ← afterPack 钩子按架构拷进 Resources/vendor/php/php
    vendor/php-mac/bin/php-x64
    vendor/php-mac/php.ini             ← 静态编译，故不含任何 extension= 行
    vendor/php-mac/router.php
    vendor/snappymail/                ← 与 Windows 共用同一份代码

用法：
    python3 scripts/fetch-vendor-mac.py
"""

import os
import shutil
import platform
import subprocess
import sys
import tarfile
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENDOR = os.path.join(ROOT, "vendor")

# 仓库内维护的 SnappyMail 定制层应用器（与 fetch-vendor.py 共用同一份）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from email_overlay import apply_overlay  # noqa: E402
PHP_DIR = os.path.join(VENDOR, "php-mac")
BIN_DIR = os.path.join(PHP_DIR, "bin")
DL = os.path.join(VENDOR, "_dl")

PHP_VERSION = "8.4.23"
# 目录名 → static-php-cli 的资产命名
ARCH_ASSET = {"arm64": "aarch64", "x64": "x86_64"}
# dl.static-php.dev 走 302 跳转，urllib 会自动跟随
PHP_URL = "https://dl.static-php.dev/static-php-cli/bulk/php-%s-cli-macos-%s.tar.gz" % (PHP_VERSION, "%s")

SNAPPY_VERSION = "2.38.2"
SNAPPY_ZIP = "snappymail-{}.zip".format(SNAPPY_VERSION)
SNAPPY_BASE = "https://github.com/the-djmaze/snappymail/releases/download/v{}/".format(SNAPPY_VERSION)
SNAPPY_URLS = [
    SNAPPY_BASE + SNAPPY_ZIP,
    "https://ghproxy.net/" + SNAPPY_BASE + SNAPPY_ZIP,
    "https://gh-proxy.com/" + SNAPPY_BASE + SNAPPY_ZIP,
    "https://ghfast.top/" + SNAPPY_BASE + SNAPPY_ZIP,
]

# SnappyMail 实际要用到的扩展（静态包里是编进去的）
REQUIRED_EXT = [
    "mbstring",   # 全程 mb_* 处理 UTF-8
    "openssl",    # IMAP/SMTP TLS
    "sodium",     # 本地口令加密
    "curl",       # OAuth2 / 插件
    "zip",        # 多附件打包下载
    "fileinfo",   # 附件类型识别
    "pdo_sqlite", # 通讯录
    "sqlite3",
    "sockets",
]

PHP_INI = r"""; 由 scripts/fetch-vendor-mac.py 生成，请勿手工修改
; e日志 桌面端内置 PHP 运行时（macOS 静态编译，{ver}）
; 静态编译：扩展已编进二进制，写 extension= 会去 dlopen 不存在的 .so 并报警告。

[PHP]
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

; 只监听 127.0.0.1，仅供本机桌面端使用；SnappyMail 配置/PGP 需要 exec 等函数
disable_functions =

opcache.enable = 1
opcache.validate_timestamps = 1
opcache.revalidate_freq = 60
""".format(ver=PHP_VERSION)

ROUTER_PHP = r"""<?php
/**
 * e日志 桌面端内置 PHP 路由（模拟 Apache .htaccess 重写）
 * 由 scripts/fetch-vendor-mac.py 生成。
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
 * 由 scripts/fetch-vendor-mac.py 生成。
 *
 * 安装目录（.app 内）对普通用户只读，而 SnappyMail 运行期要写
 * 配置/缓存/会话/通讯录，因此把数据目录指向 Electron 的 userData。
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


def fetch(urls, target, label, min_size=1024 * 1024):
    """按序尝试多个地址；已存在且大小正常则跳过。"""
    if os.path.exists(target) and os.path.getsize(target) > min_size:
        log("  [跳过] {} 已存在 ({:.1f} MB)".format(label, os.path.getsize(target) / 1048576))
        return True
    if isinstance(urls, str):
        urls = [urls]
    for i, url in enumerate(urls, 1):
        log("  [下载] {} ({}/{})".format(label, i, len(urls)))
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "mylog-fetch-vendor"})
            with urllib.request.urlopen(req, timeout=300) as resp, open(target, "wb") as out:
                shutil.copyfileobj(resp, out, 1024 * 256)
            size = os.path.getsize(target)
            if size > min_size:
                log("         OK {:.1f} MB".format(size / 1048576))
                return True
            log("         文件过小，换下一个源")
        except Exception as e:
            log("         失败：{}".format(e))
        try:
            os.remove(target)
        except OSError:
            pass
    return False


def extract_php(archive, dest):
    """static-php-cli 的 tar 里只有一个成员：php"""
    with tarfile.open(archive) as t:
        member = None
        for m in t.getmembers():
            if m.isfile() and os.path.basename(m.name) == "php":
                member = m
                break
        if member is None:
            raise RuntimeError("压缩包里没有 php 可执行文件：{}".format(archive))
        src = t.extractfile(member)
        with open(dest, "wb") as out:
            shutil.copyfileobj(src, out)
    os.chmod(dest, 0o755)


def extract_zip(zip_path, dest):
    if os.path.isdir(dest):
        shutil.rmtree(dest, ignore_errors=True)
    os.makedirs(dest, exist_ok=True)
    with zipfile.ZipFile(zip_path) as z:
        for n in z.namelist():
            if not n or n.endswith("/"):
                continue
            target = os.path.join(dest, *n.split("/"))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with z.open(n) as s, open(target, "wb") as out:
                shutil.copyfileobj(s, out)


def check_extensions(binary):
    """只在同架构的本机（macOS runner）上真跑一次 php -m。"""
    if platform.system() != "Darwin":
        log("  [跳过] 非 macOS，无法执行 php -m")
        return True
    try:
        out = subprocess.run([binary, "-v"], capture_output=True, text=True, timeout=60)
        log("  " + (out.stdout or out.stderr).splitlines()[0])
        mods = subprocess.run([binary, "-m"], capture_output=True, text=True, timeout=60).stdout.lower()
    except Exception as e:
        log("  [警告] 执行 {} 失败：{}".format(binary, e))
        return True
    missing = [e for e in REQUIRED_EXT if e not in mods]
    if missing:
        log("  [警告] 缺少扩展：{}（SnappyMail 可能无法收发信）".format(", ".join(missing)))
        return False
    log("  扩展检查通过：{}".format(", ".join(REQUIRED_EXT)))
    return True


def main():
    os.makedirs(DL, exist_ok=True)
    os.makedirs(BIN_DIR, exist_ok=True)

    log("== 1/3 下载静态 PHP {}（PHP License v3.01）".format(PHP_VERSION))
    for arch, asset in ARCH_ASSET.items():
        dest = os.path.join(BIN_DIR, "php-" + arch)
        if os.path.exists(dest) and os.path.getsize(dest) > 1024 * 1024:
            log("  [跳过] php-{} 已存在 ({:.1f} MB)".format(arch, os.path.getsize(dest) / 1048576))
            continue
        archive = os.path.join(DL, "php-macos-{}.tar.gz".format(asset))
        if not fetch(PHP_URL % asset, archive, "PHP {} ({})".format(PHP_VERSION, arch)):
            log("  下载失败：{}，请检查网络".format(asset))
            return 1
        extract_php(archive, dest)
        log("  php-{} -> {:.1f} MB".format(arch, os.path.getsize(dest) / 1048576))

    log("== 2/3 下载 SnappyMail {}（AGPL-3.0）".format(SNAPPY_VERSION))
    snap_dir = os.path.join(VENDOR, "snappymail")
    if os.path.exists(os.path.join(snap_dir, "index.php")):
        log("  [跳过] vendor/snappymail 已存在")
    else:
        snap_zip = os.path.join(DL, SNAPPY_ZIP)
        if not fetch(SNAPPY_URLS, snap_zip, "SnappyMail " + SNAPPY_VERSION):
            log("  SnappyMail 下载失败，请检查网络")
            return 1
        extract_zip(snap_zip, snap_dir)
        log("  SnappyMail -> vendor/snappymail")

    log("== 3/3 生成配置并验证")
    log("  --- 应用 email-overlay（邮箱 UI / 插件 / 域名配置）---")
    apply_overlay(ROOT, VENDOR, SNAPPY_VERSION, log)

    with open(os.path.join(PHP_DIR, "php.ini"), "w", encoding="utf-8", newline="\n") as f:
        f.write(PHP_INI)
    with open(os.path.join(PHP_DIR, "router.php"), "w", encoding="utf-8", newline="\n") as f:
        f.write(ROUTER_PHP)
    if not os.path.exists(os.path.join(snap_dir, "include.php")):
        with open(os.path.join(snap_dir, "include.php"), "w", encoding="utf-8", newline="\n") as f:
            f.write(SNAPPY_INCLUDE_PHP)

    ok = True

    # SnappyMail 定制层：这几项丢了 PHP 照样起得来，但用户看到的是原版界面
    _idx = os.path.join(snap_dir, "snappymail", "v", SNAPPY_VERSION, "app", "templates", "Index.html")
    if not os.path.isfile(_idx):
        log("  [失败] 缺少 SnappyMail 模板 Index.html")
        ok = False
    elif "eb-mail-theme" not in open(_idx, encoding="utf-8", errors="replace").read():
        log("  [失败] Index.html 缺 eb-mail-theme 注入层（邮箱会显示原版界面）")
        ok = False
    else:
        log("  UI 注入层 OK：eb-mail-theme 存在")
    for _rel in ("plugins/mylog-provider/index.php",
                 "plugins/mylog-provider/providers.php",
                 "data/_data_/_default_/configs/application.ini",
                 "data/_data_/_default_/domains/default.json"):
        if not os.path.isfile(os.path.join(snap_dir, *_rel.split("/"))):
            log("  [失败] 缺少 " + _rel)
            ok = False

    for arch in ("arm64", "x64"):
        log("  --- 校验 php-{} ---".format(arch))
        ok = check_extensions(os.path.join(BIN_DIR, "php-" + arch)) and ok

    shutil.rmtree(DL, ignore_errors=True)
    log("")
    log("完成：vendor/php-mac/bin {} + vendor/snappymail".format(
        ", ".join("{} {:.1f} MB".format(f, os.path.getsize(os.path.join(BIN_DIR, f)) / 1048576)
                  for f in sorted(os.listdir(BIN_DIR)))))
    if not ok:
        log("注意：扩展检查未全通过，见上面的警告。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
