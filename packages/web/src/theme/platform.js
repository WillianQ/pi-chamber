// ============================================================================
// 平台判定唯一出口：布局分发（layout/index.jsx）与字号档位（theme/tokens.js）共用。
// 一次判定、缓存结果——与"两套布局按 UA 分发一次"的既有语义保持一致：
// 桌面浏览器拖窄窗口不会变字号，也不会换布局（要看移动态请用 ?layout=mobile）。
// 之所以抽到这里而不是留在 layout 里：字号档位住在 tokens（唯一真相源），
// 若 tokens 反向 import layout 会成环。
// ============================================================================

let cached = null;

export function isMobilePlatform() {
  if (cached !== null) return cached;
  if (typeof window === "undefined") {
    cached = false; // 非浏览器环境（构建期/单测）按桌面档
    return cached;
  }
  const forced = new URLSearchParams(window.location.search).get("layout");
  if (forced === "mobile") cached = true;
  else if (forced === "desktop") cached = false;
  else {
    const nav = navigator;
    cached = nav.userAgentData !== undefined ? !!nav.userAgentData.mobile : /Mobi|Android|iPhone|iPad/i.test(nav.userAgent);
  }
  return cached;
}
