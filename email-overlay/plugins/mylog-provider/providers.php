<?php

/**
 * e日志 桌面端 · 邮箱服务商清单（唯一权威数据源）
 *
 * 这份清单同时用于两端，改这里就够了：
 *   1) 后端：插件按用户选择的 key，把 IMAP/SMTP 服务器换成对应服务商（见 index.php）
 *   2) 前端：登录页「邮箱类型」下拉的选项，由插件通过 rl.pluginSettingsGet() 下发
 *      （见 mylog-provider.js），**不需要**再去改 JS。
 *
 * 字段说明：
 *   label  下拉里显示的名字
 *   hint   选中后显示在下方的一句提示（可选）
 *   custom 为 true 时，前端会展开「自定义服务器」输入框（IMAP/SMTP 主机名）
 *   imap / smtp  { host, port, type }
 *     type: 0 = 不加密，1 = SSL/TLS（993、465 用这个），2 = STARTTLS（587 用这个）
 *
 * 新增服务商：在下面加一项即可，key 用小写字母与短横线。
 * 注意 key 一旦发布就不要再改，用户的浏览器里按 key 记录了选择。
 */

return [

	'aliyun' => [
		'label' => '阿里企业邮箱（标准版）',
		'hint'  => '密码请填「客户端专用密码 / 授权码」，不是网页登录密码',
		'imap'  => ['host' => 'imap.qiye.aliyun.com', 'port' => 993, 'type' => 1],
		'smtp'  => ['host' => 'smtp.qiye.aliyun.com', 'port' => 465, 'type' => 1],
	],

	'aliyun-intl' => [
		'label' => '阿里企业邮箱（外贸版）',
		'hint'  => '阿里邮箱国际站 / 外贸版，服务器为 alibaba.com',
		'imap'  => ['host' => 'imap.alibaba.com', 'port' => 993, 'type' => 1],
		'smtp'  => ['host' => 'smtp.alibaba.com', 'port' => 465, 'type' => 1],
	],

	'tencent' => [
		'label' => '腾讯企业邮',
		'hint'  => '需管理员开启 IMAP/SMTP，并使用「客户端专用密码」登录',
		'imap'  => ['host' => 'imap.exmail.qq.com', 'port' => 993, 'type' => 1],
		'smtp'  => ['host' => 'smtp.exmail.qq.com', 'port' => 465, 'type' => 1],
	],

	'qq' => [
		'label' => 'QQ 邮箱',
		'hint'  => '密码请填 QQ 邮箱设置里生成的「授权码」',
		'imap'  => ['host' => 'imap.qq.com', 'port' => 993, 'type' => 1],
		'smtp'  => ['host' => 'smtp.qq.com', 'port' => 465, 'type' => 1],
	],

	'netease-qiye' => [
		'label' => '网易企业邮箱',
		'hint'  => '需在邮箱设置中开启客户端服务',
		'imap'  => ['host' => 'imap.qiye.163.com', 'port' => 993, 'type' => 1],
		'smtp'  => ['host' => 'smtp.qiye.163.com', 'port' => 994, 'type' => 1],
	],

	'netease-163' => [
		'label' => '网易 163 邮箱',
		'hint'  => '密码请填邮箱设置里开启 IMAP 后生成的「授权码」',
		'imap'  => ['host' => 'imap.163.com', 'port' => 993, 'type' => 1],
		'smtp'  => ['host' => 'smtp.163.com', 'port' => 465, 'type' => 1],
	],

	'gmail' => [
		'label' => 'Gmail（谷歌邮箱）',
		'hint'  => '需先在谷歌账号里开启两步验证，再生成「应用专用密码」',
		'imap'  => ['host' => 'imap.gmail.com', 'port' => 993, 'type' => 1],
		'smtp'  => ['host' => 'smtp.gmail.com', 'port' => 465, 'type' => 1],
	],

	'outlook' => [
		'label' => 'Outlook / Microsoft 365',
		'hint'  => '企业账号可能需管理员开启 IMAP；发信使用 STARTTLS 587 端口',
		'imap'  => ['host' => 'outlook.office365.com', 'port' => 993, 'type' => 1],
		'smtp'  => ['host' => 'smtp.office365.com', 'port' => 587, 'type' => 2],
	],

	// 兜底：公司自建邮件服务器等，由用户自己填服务器地址
	'custom' => [
		'label' => '其他（自定义服务器）',
		'hint'  => '填写公司邮件服务器地址，收信默认 993/SSL、发信默认 465/SSL',
		'custom' => true,
		'imap'  => ['host' => '', 'port' => 993, 'type' => 1],
		'smtp'  => ['host' => '', 'port' => 465, 'type' => 1],
	],

];
