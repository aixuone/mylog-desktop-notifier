/**
 * e日志 桌面端 · SnappyMail「邮箱类型」下拉（前端）
 *
 * 由插件 mylog-provider 通过 AddJs 注入，只在登录页生效。
 *
 * 职责很轻：
 *   1) 在登录表单里插入一个「邮箱类型」下拉（选项由后端 providers.php 下发，
 *      通过官方 API rl.pluginSettingsGet 读取，因此这里没有重复的服务商清单）；
 *   2) 用户选择后写入 cookie，后端插件 filter.domain 读 cookie 换服务器。
 *
 * 拿不到清单就不注入，页面退回 SnappyMail 原生两框 —— 保证任何情况下都能登录。
 */
(function () {
	'use strict';

	var PLUGIN = 'mylog-provider';

	var COOKIE_PROVIDER = 'mylog_provider';
	var COOKIE_IMAP     = 'mylog_custom_imap';
	var COOKIE_SMTP     = 'mylog_custom_smtp';

	var MAX_AGE = 60 * 60 * 24 * 365; // 一年
	var WAIT_MS = 20000;              // 等 AppData 的上限
	var READY_ATTR = 'data-mylog-provider';

	// ── cookie ───────────────────────────────────────────────────

	function getCookie(name) {
		var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name.replace(/[-.]/g, '\\$&') + '=([^;]*)'));
		return m ? decodeURIComponent(m[1]) : '';
	}

	function setCookie(name, value) {
		document.cookie = name + '=' + encodeURIComponent(value) +
			';path=/;max-age=' + MAX_AGE + ';SameSite=Lax';
	}

	// ── 服务商清单（来自后端单一数据源）──────────────────────────

	function getProviders() {
		try {
			if (window.rl && typeof rl.pluginSettingsGet === 'function') {
				var list = rl.pluginSettingsGet(PLUGIN, 'providers');
				if (list && list.length && list.length > 0) return list;
			}
		} catch (e) { /* 忽略：可能 AppData 尚未就绪 */ }
		return null;
	}

	// ── 样式 ─────────────────────────────────────────────────────

	function injectStyle() {
		if (document.getElementById('mylog-provider-style')) return;
		// 登录页是固定的深色皮肤（见 SnappyMail 的 .LoginView input：白边框 + 透明底），
		// 原生 select 默认是白底直角，会与其它输入框不一致，这里显式对齐。
		var css = '' +
			'.mylog-provider-wrap{margin-bottom:10px}' +
			'.mylog-provider-wrap select{' +
			'display:block;width:100%;box-sizing:border-box;height:40px;padding:0 10px;' +
			'font-size:100%;font-family:inherit;line-height:normal;' +
			'color:#fff;background:transparent;' +
			'border:1px solid rgba(255,255,255,.8);border-radius:3px}' +
			'.mylog-provider-wrap select:hover,.mylog-provider-wrap select:focus{border-color:#fff}' +
			'.mylog-provider-wrap select option{color:#333;background:#fff}' +
			'.mylog-provider-hint{font-size:12px;line-height:1.5;opacity:.75;margin:-4px 2px 14px}' +
			'.mylog-provider-custom{margin-top:6px}';
		var style = document.createElement('style');
		style.id = 'mylog-provider-style';
		style.type = 'text/css';
		style.appendChild(document.createTextNode(css));
		(document.head || document.documentElement).appendChild(style);
	}

	// ── 构建下拉 ─────────────────────────────────────────────────

	function build(list) {
		var anchor = document.getElementById('plugin-Login-BottomControlGroup');
		var emailInput = document.querySelector('form input[name="Email"]');

		// 优先插到「邮箱」输入框上方（先选类型，再填邮箱，符合直觉）
		var before = null;
		if (emailInput && emailInput.closest) {
			before = emailInput.closest('.controls') || emailInput.parentNode;
		} else if (anchor) {
			before = anchor;
		}
		if (!before || !before.parentNode) return false;

		injectStyle();

		var savedKey = getCookie(COOKIE_PROVIDER);

		var wrap = document.createElement('div');
		wrap.className = 'mylog-provider-wrap';
		wrap.setAttribute(READY_ATTR, '1');
		var sel = document.createElement('select');
		sel.id = 'mylog-provider-select';
		sel.className = 'input-block-level';
		sel.setAttribute('aria-label', '邮箱类型');

		var hasSaved = false;
		for (var i = 0; i < list.length; i++) {
			var p = list[i];
			var opt = document.createElement('option');
			opt.value = p.key;
			opt.textContent = p.label;
			if (savedKey && savedKey === p.key) { opt.selected = true; hasSaved = true; }
			sel.appendChild(opt);
		}
		// 用户从没选过：默认落在第一项，但不写 cookie（保持与后端默认配置一致）
		if (!hasSaved) sel.selectedIndex = 0;

		wrap.appendChild(sel);

		// 提示文案跟着「密码」走：填什么密码由邮箱类型决定，放在密码框正下方最近处
		var hint = document.createElement('div');
		hint.className = 'mylog-provider-hint';
		var pwInput = document.querySelector('form input[name="Password"]');
		var pwCtl = pwInput && pwInput.closest ? pwInput.closest('.controls') : null;
		if (pwCtl && pwCtl.parentNode) {
			pwCtl.parentNode.insertBefore(hint, pwCtl.nextSibling);
		} else {
			wrap.appendChild(hint);
		}

		var custom = document.createElement('div');
		custom.className = 'mylog-provider-custom';
		custom.style.display = 'none';

		custom.appendChild(makeControl('📥', 'mylog-imap-host', '收信服务器，如 mail.example.com'));
		custom.appendChild(makeControl('📤', 'mylog-smtp-host', '发信服务器，默认同上'));
		wrap.appendChild(custom);

		function currentMeta(key) {
			for (var n = 0; n < list.length; n++) {
				if (list[n].key === key) return list[n];
			}
			return null;
		}

		function sync() {
			var meta = currentMeta(sel.value);
			hint.textContent = meta && meta.hint ? meta.hint : '';
			custom.style.display = (meta && meta.custom) ? '' : 'none';
		}

		function persist() {
			setCookie(COOKIE_PROVIDER, sel.value);
			var meta = currentMeta(sel.value);
			if (meta && meta.custom) {
				setCookie(COOKIE_IMAP, custom.querySelector('#mylog-imap-host').value.trim());
				setCookie(COOKIE_SMTP, custom.querySelector('#mylog-smtp-host').value.trim());
			}
		}

		// 回填自定义服务器
		var imapEl = custom.querySelector('#mylog-imap-host');
		var smtpEl = custom.querySelector('#mylog-smtp-host');
		if (imapEl) imapEl.value = getCookie(COOKIE_IMAP);
		if (smtpEl) smtpEl.value = getCookie(COOKIE_SMTP);

		sel.addEventListener('change', function () { sync(); persist(); });
		if (imapEl) imapEl.addEventListener('change', persist);
		if (smtpEl) smtpEl.addEventListener('change', persist);
		// 自定义框失焦也保存一次，避免用户直接点登录没触发 change
		if (imapEl) imapEl.addEventListener('blur', persist);
		if (smtpEl) smtpEl.addEventListener('blur', persist);

		sync();

		before.parentNode.insertBefore(wrap, before);
		return true;
	}

	function makeControl(icon, id, placeholder) {
		var box = document.createElement('div');
		box.className = 'controls';
		var span = document.createElement('span');
		span.className = 'fontastic';
		span.textContent = icon;
		var input = document.createElement('input');
		input.id = id;
		input.type = 'text';
		input.className = 'input-block-level';
		input.setAttribute('spellcheck', 'false');
		input.setAttribute('autocorrect', 'off');
		input.setAttribute('autocapitalize', 'off');
		input.setAttribute('placeholder', placeholder);
		box.appendChild(span);
		box.appendChild(input);
		return box;
	}

	// ── 等待条件就绪后注入 ───────────────────────────────────────

	function alreadyInjected() {
		return !!document.querySelector('[' + READY_ATTR + '="1"]');
	}

	function tryInject() {
		if (alreadyInjected()) return true;
		if (!document.getElementById('plugin-Login-BottomControlGroup') &&
			!document.querySelector('form input[name="Email"]')) {
			return false; // 不在登录页
		}
		var list = getProviders();
		if (!list) return false; // AppData 还没到，等下一轮
		return build(list);
	}

	var waited = 0;
	var timer = setInterval(function () {
		waited += 250;
		if (tryInject() || waited >= WAIT_MS) {
			clearInterval(timer);
		}
	}, 250);

	// DOM 一变就试一次（SPA 切换视图后可能才出现登录表单）
	if (window.MutationObserver) {
		var mo = new MutationObserver(function () {
			if (tryInject()) mo.disconnect();
		});
		try {
			mo.observe(document.documentElement, { childList: true, subtree: true });
			setTimeout(function () { mo.disconnect(); }, WAIT_MS);
		} catch (e) { /* 忽略 */ }
	}
})();
