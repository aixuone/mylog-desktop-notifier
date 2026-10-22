<?php

/**
 * e日志 桌面端 · SnappyMail「邮箱类型选择」插件
 *
 * 背景
 *   SnappyMail 的登录页只有「邮箱 + 密码」两个输入框，连哪台服务器完全由
 *   「域名配置」决定（<邮箱域名>.json，找不到就回落通配的 default.json）。
 *   这导致用户无法自己指定服务商：同一个邮箱域名换服务商、或不同同事用不同
 *   服务商时，没法区分。
 *
 * 做法（全部走 SnappyMail 官方扩展点，不修改其任何核心代码）
 *   1) 前端 mylog-provider.js 在登录页注入「邮箱类型」下拉，用户选择写入 cookie；
 *   2) 本插件挂在官方钩子 filter.domain 上 —— 该钩子在每次加载域名配置时触发，
 *      此时把 IMAP/SMTP 的 host/port/加密方式换成所选服务商的（见 providers.php）。
 *
 * 为什么用 filter.domain 而不是别的钩子
 *   这是 SnappyMail 官方为「动态决定服务器地址」预留的钩子，官方插件
 *   auto-domain-grab 就是同样用法（$oSettings->host = ...）。因此升级 SnappyMail
 *   时不受影响。
 *
 * 服务商清单在 providers.php（唯一数据源），前端下拉的选项也由本插件下发，
 * 所以增删服务商只需改 providers.php 一个文件。
 */

class MylogProviderPlugin extends \RainLoop\Plugins\AbstractPlugin
{
	const
		NAME        = 'mylog-provider',
		AUTHOR      = 'e日志',
		VERSION     = '1.1.0',
		RELEASE     = '2026-10-19',
		REQUIRED    = '2.24.0',
		CATEGORY    = 'Login',
		LICENSE     = 'AGPL v3',
		DESCRIPTION = '在登录页提供「邮箱类型」下拉，自动匹配对应服务商的 IMAP / SMTP 服务器';

	/** cookie：用户选择的服务商 key */
	const COOKIE_PROVIDER    = 'mylog_provider';
	/** cookie：自定义模式下的 IMAP 主机名 */
	const COOKIE_CUSTOM_IMAP = 'mylog_custom_imap';
	/** cookie：自定义模式下的 SMTP 主机名 */
	const COOKIE_CUSTOM_SMTP = 'mylog_custom_smtp';

	/** @var array|null 进程内缓存的服务商清单 */
	private static $sProviders = null;

	/** @var array 同一次请求内已记录的日志签名，避免重复刷屏 */
	private static $aLogged = [];

	// ──────────────────────────────────────────────────────────────
	// 生命周期
	// ──────────────────────────────────────────────────────────────

	public function Init() : void
	{
		// 官方钩子：每次加载域名配置时触发，用来把服务器换成所选服务商的
		$this->addHook('filter.domain', 'filterDomain');
		// 登录页注入「邮箱类型」下拉
		$this->addJs('mylog-provider.js');
	}

	/**
	 * 把服务商清单下发给前端（前端用 rl.pluginSettingsGet('mylog-provider','providers') 读取）。
	 * 只下发展示需要的字段，不下发服务器地址（服务器地址留在后端，避免被前端篡改）。
	 */
	public function FilterAppDataPluginSection(bool $bAdmin, bool $bAuth, array &$aConfig) : void
	{
		$list = [];
		foreach (self::providers() as $sKey => $aProvider) {
			$list[] = [
				'key'    => $sKey,
				'label'  => $aProvider['label'],
				'hint'   => isset($aProvider['hint']) ? $aProvider['hint'] : '',
				'custom' => !empty($aProvider['custom']),
			];
		}
		$aConfig['providers'] = $list;
	}

	// ──────────────────────────────────────────────────────────────
	// 核心：按用户选择替换服务器
	// ──────────────────────────────────────────────────────────────

	/**
	 * @param \RainLoop\Model\Domain $oDomain 由 SnappyMail 传入，属性可直接改写
	 */
	public function filterDomain($oDomain) : void
	{
		try {
			$sKey = $this->selectedProvider();
			if ('' === $sKey) {
				// 用户没选过 → 保持 SnappyMail 默认行为（回落 default.json）
				return;
			}

			$aList = self::providers();
			if (!isset($aList[$sKey])) {
				$this->log("unknown provider '{$sKey}', keep default");
				return;
			}
			$aProvider = $aList[$sKey];

			$oImap = $oDomain->ImapSettings();
			$oSmtp = $oDomain->SmtpSettings();
			$sBefore = $oImap->host . ':' . $oImap->port;

			if (!empty($aProvider['custom'])) {
				// 自定义：主机名取自 cookie，端口与加密方式用安全默认值
				$sImapHost = $this->cleanHost(isset($_COOKIE[self::COOKIE_CUSTOM_IMAP]) ? $_COOKIE[self::COOKIE_CUSTOM_IMAP] : '');
				$sSmtpHost = $this->cleanHost(isset($_COOKIE[self::COOKIE_CUSTOM_SMTP]) ? $_COOKIE[self::COOKIE_CUSTOM_SMTP] : '');
				if ('' === $sImapHost && '' === $sSmtpHost) {
					$this->log('custom provider selected but no host given, keep default');
					return;
				}
				if ('' !== $sImapHost) {
					$oImap->host = $sImapHost;
					$oImap->port = (int) $aProvider['imap']['port'];
					$oImap->type = (int) $aProvider['imap']['type'];
				}
				if ('' !== $sSmtpHost) {
					$oSmtp->host = $sSmtpHost;
					$oSmtp->port = (int) $aProvider['smtp']['port'];
					$oSmtp->type = (int) $aProvider['smtp']['type'];
				}
			} else {
				$oImap->host = $aProvider['imap']['host'];
				$oImap->port = (int) $aProvider['imap']['port'];
				$oImap->type = (int) $aProvider['imap']['type'];

				$oSmtp->host = $aProvider['smtp']['host'];
				$oSmtp->port = (int) $aProvider['smtp']['port'];
				$oSmtp->type = (int) $aProvider['smtp']['type'];
			}

			// 诊断用：只在服务器真的变了时记一行，且同一请求内不重复
			if ($sBefore !== $oImap->host . ':' . $oImap->port) {
				$sSig = $sKey . '|' . $oImap->host . ':' . $oImap->port;
				if (!isset(self::$aLogged[$sSig])) {
					self::$aLogged[$sSig] = true;
					$this->log("domain '{$oDomain->Name()}' → {$sKey}: IMAP {$oImap->host}:{$oImap->port} / SMTP {$oSmtp->host}:{$oSmtp->port}");
				}
			}
		} catch (\Throwable $oException) {
			// 插件出错绝不能连累登录，静默退回默认配置
			$this->log('filterDomain error: ' . $oException->getMessage());
		}
	}

	// ──────────────────────────────────────────────────────────────
	// 辅助
	// ──────────────────────────────────────────────────────────────

	/**
	 * 服务商清单（providers.php 为唯一数据源）
	 */
	public static function providers() : array
	{
		if (null === self::$sProviders) {
			$sFile = __DIR__ . '/providers.php';
			$aData = \is_readable($sFile) ? include $sFile : [];
			self::$sProviders = \is_array($aData) ? $aData : [];
		}
		return self::$sProviders;
	}

	/**
	 * 读用户选择的服务商 key（cookie）
	 */
	private function selectedProvider() : string
	{
		$sValue = isset($_COOKIE[self::COOKIE_PROVIDER]) ? $_COOKIE[self::COOKIE_PROVIDER] : '';
		$sValue = \strtolower(\preg_replace('/[^A-Za-z0-9\-]/', '', (string) $sValue));
		return $sValue;
	}

	/**
	 * 清洗用户填的服务器主机名，只保留合法字符（防注入/防误填）
	 */
	private function cleanHost($sHost) : string
	{
		$sHost = \strtolower(\trim((string) $sHost));
		$sHost = \preg_replace('/[^a-z0-9.\-]/', '', $sHost);
		// 去掉首尾的点与短横线，并限制长度
		$sHost = \trim($sHost, '.-');
		return \strlen($sHost) > 2 && \strlen($sHost) <= 253 ? $sHost : '';
	}

	/**
	 * 诊断日志：写到 userData/email/mylog-provider.log
	 * 与主进程的 php-server.log 同目录，方便一次性排障。
	 */
	private function log(string $sMessage) : void
	{
		try {
			if (!\defined('APP_DATA_FOLDER_PATH')) {
				return;
			}
			$sFile = \dirname(APP_DATA_FOLDER_PATH) . \DIRECTORY_SEPARATOR . 'mylog-provider.log';
			if (\is_file($sFile) && \filesize($sFile) > 524288) {
				// 超过 512KB 就重开，避免无限增长
				\file_put_contents($sFile, '');
			}
			\file_put_contents($sFile, '[' . \date('Y-m-d H:i:s') . '] ' . $sMessage . "\n", \FILE_APPEND);
		} catch (\Throwable $oException) {
			// 记日志失败无所谓
		}
	}
}
