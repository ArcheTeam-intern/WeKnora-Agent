/* Credential parsing is only a UI hint. WeKnora always verifies the JWT. */
(function (root) {
  "use strict";
  const DEFAULT_EMAIL = "15918868657@163.com";
  function claims(token) {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) throw new Error();
      const raw = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw), c => c.charCodeAt(0))));
    } catch (_) { throw new Error("Token 格式无效，请使用 WeKnora 签发的用户 JWT"); }
  }
  function normalize(value, now = Date.now() / 1000) {
    const token = String(value.token || "").trim().replace(/^Bearer\s+/i, "");
    const payload = claims(token);
    const expiry = Number(payload.exp);
    if (!Number.isFinite(expiry) || expiry <= now) throw new Error("Token 已过期，请使用独立凭证工具重新登录后导入");
    const profile = value.profile || value;
    const tenant = String(profile.tenant_id || value.workspace_id || "").trim();
    if (!/^[1-9]\d*$/.test(tenant)) throw new Error("请填写有效的工作空间 ID");
    return { token, expires_at: expiry, tenant_id: tenant,
      email: String(profile.email || DEFAULT_EMAIL).trim(),
      name: String(profile.name || profile.email || DEFAULT_EMAIL),
      user_id: String(profile.user_id || "") };
  }
  function redact(value) {
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== "object") return value;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = /^(password|token|access_token|refresh_token|authorization|x-weknora-user-token|api_key)$/i.test(key)
        ? "[已隐藏]" : redact(item);
    }
    if ((value.name === "upload_file" || value.method === "upload_file") && result.arguments?.content) {
      result.arguments.content = `[文件字节已隐藏，${String(value.arguments.content).length} 个编码字符]`;
    }
    return result;
  }
  function isAuthError(status, data = {}) {
    return status === 401 || data.http_status === 401 || data.error_code === 'UNAUTHORIZED';
  }
  function canInvalidate(requestToken, current) {
    return Boolean(requestToken && current && requestToken === current.token);
  }
  const api = { normalize, redact, DEFAULT_EMAIL, isAuthError, canInvalidate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TokenSession = api;
})(typeof window === "undefined" ? this : window);
