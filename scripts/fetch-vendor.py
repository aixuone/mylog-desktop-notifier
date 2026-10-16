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
import shutil
import sys
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENDOR = os.path.join(ROOT, "vendor")
DL = os.path.join(VENDOR, "_dl")

PHP_VERSION = "8.4.26"
PHP_ZIP = "php-{}-nts-Win32-vs17-x64.zip".format(PHP_VERSION)
PHP_URLS = [
    "https://downloads.php.net/~windows/releases/" + PHP_ZIP,
    "https://windows.php.net/downloads/releases/" + PHP_ZIP,
]

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
}

PHP_INI = r"""; 由 scripts/fetch-vendor.py 生成，请勿手工修改（改动会被覆盖）
; e日志 桌面端内置 PHP 运行时（NTS x64，{ver}）

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

; ── opcache（Zend 扩展，必须用 zend_extension）──
zend_extension=opcache
opcache.enable = 1
opcache.enable_cli = 1
opcache.memory_consumption = 128
opcache.interned_strings_buffer = 16
opcache.max_accelerated_files = 10000
opcache.validate_timestamps = 1
opcache.revalidate_freq = 60
""".format(ver=PHP_VERSION)

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


def download(urls, target, label):
    """按序尝试多个地址下载；支持断点重试。"""
    if os.path.exists(target) and os.path.getsize(target) > 1024 * 1024:
        log("  [跳过] {} 已存在 ({:.1f} MB)".format(label, os.path.getsize(target) / 1048576))
        return True
    for i, url in enumerate(urls, 1):
        log("  [下载] {} ({}/{})".format(label, i, len(urls)))
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "mylog-fetch-vendor"})
            with urllib.request.urlopen(req, timeout=180) as resp, open(target, "wb") as out:
                shutil.copyfileobj(resp, out, 1024 * 256)
            size = os.path.getsize(target)
            if size > 1024 * 1024:
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


def main():
    os.makedirs(DL, exist_ok=True)

    log("== 1/4 下载便携版 PHP {}（PHP License v3.01）".format(PHP_VERSION))
    php_zip = os.path.join(DL, PHP_ZIP)
    if not download(PHP_URLS, php_zip, "PHP " + PHP_VERSION):
        log("PHP 下载失败，请检查网络后重试。")
        return 1

    log("== 2/4 下载 SnappyMail {}（AGPL-3.0）".format(SNAPPY_VERSION))
    snap_zip = os.path.join(DL, SNAPPY_ZIP)
    if not download(SNAPPY_URLS, snap_zip, "SnappyMail " + SNAPPY_VERSION):
        log("SnappyMail 下载失败，请检查网络后重试。")
        return 1

    log("== 3/4 解压")
    php_dir = os.path.join(VENDOR, "php")
    snap_dir = os.path.join(VENDOR, "snappymail")
    extract_zip(php_zip, php_dir)
    log("  PHP -> vendor/php")
    extract_zip(snap_zip, snap_dir)
    log("  SnappyMail -> vendor/snappymail")

    log("== 4/4 裁剪与配置")
    trim_php(php_dir)
    with open(os.path.join(php_dir, "php.ini"), "w", encoding="utf-8", newline="\n") as f:
        f.write(PHP_INI)
    with open(os.path.join(php_dir, "router.php"), "w", encoding="utf-8", newline="\n") as f:
        f.write(ROUTER_PHP)
    with open(os.path.join(snap_dir, "include.php"), "w", encoding="utf-8", newline="\n") as f:
        f.write(SNAPPY_INCLUDE_PHP)

    shutil.rmtree(DL, ignore_errors=True)

    log("")
    log("完成：vendor/php {:.1f} MB + vendor/snappymail {:.1f} MB".format(
        dir_size_mb(php_dir), dir_size_mb(snap_dir)))
    log("下一步：node --check main.js && npm run pack")
    return 0


if __name__ == "__main__":
    sys.exit(main())
