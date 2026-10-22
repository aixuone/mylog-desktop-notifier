#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
email_overlay.py —— 把仓库里的 email-overlay 应用到解压后的 SnappyMail

为什么需要这一层：
    邮箱的全部定制（UI 主题注入、mylog-provider 插件、阿里企业邮箱域名配置）
    原先只存在于 vendor/snappymail 里。而 vendor 不进 git，CI 每次都是下载
    官方原版，于是「本地看着是新 UI，装出来是原版」，插件和域名配置也一起丢，
    全新用户甚至会「无法连接服务器」。

    所以把这些文件放进 git（email-overlay/），由两个 vendor 脚本在解压之后
    统一覆盖上去。Windows（fetch-vendor.py）与 macOS（fetch-vendor-mac.py）
    共用本模块，避免两边各写一份走样。

overlay 内的路径不带版本号，升级 SnappyMail 时自动跟随：
    app/...      -> snappymail/v/<ver>/app/...
    static/...   -> snappymail/v/<ver>/static/...
    plugins/...  -> snappymail/plugins/...
    data/...     -> snappymail/data/...

    data/SALT.php、data/INSTALLED、data/_data_/*/cache 属于每个安装的运行期
    产物，绝不能进 overlay（SALT 是加密盐，各安装必须唯一）。
"""

import io
import os
import shutil

OVERLAY_DIRNAME = "email-overlay"


def overlay_path(root):
    return os.path.join(root, OVERLAY_DIRNAME)


def adapted_version(root):
    p = os.path.join(overlay_path(root), "ADAPTED_VERSION")
    if os.path.isfile(p):
        try:
            return io.open(p, encoding="utf-8").read().strip()
        except OSError:
            return ""
    return ""


def apply_overlay(root, vendor, snap_ver, log=print):
    """返回 (ok, 应用的文件数)。ok=False 表示 overlay 缺失。"""
    src_root = overlay_path(root)
    if not os.path.isdir(src_root):
        log("  [警告] 没有 email-overlay，邮箱将是原版界面且缺 mylog-provider 插件")
        return False, 0

    adapted = adapted_version(root)
    if adapted and adapted != snap_ver:
        log("  [警告] overlay 适配的是 SnappyMail {}，当前是 {}：模板结构可能已变，"
            "请核对 Index.html 的注入锚点（<head> 内是否仍可插入 eb-mail-theme）"
            .format(adapted, snap_ver))

    snap = os.path.join(vendor, "snappymail")
    n = 0
    for cur, _, files in os.walk(src_root):
        for name in files:
            src = os.path.join(cur, name)
            rel = os.path.relpath(src, src_root).replace("\\", "/")
            if rel == "ADAPTED_VERSION":
                continue
            if rel.startswith("app/") or rel.startswith("static/"):
                dst = os.path.join(snap, "snappymail", "v", snap_ver, *rel.split("/"))
            else:
                dst = os.path.join(snap, *rel.split("/"))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copyfile(src, dst)
            n += 1
            log("    overlay <- " + rel)
    log("  已应用 {} 个覆盖文件".format(n))
    return True, n
