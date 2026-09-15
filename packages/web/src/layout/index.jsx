import { DesktopLayout } from "./DesktopLayout.jsx";
import { MobileLayout } from "./MobileLayout.jsx";
import { isMobilePlatform } from "../theme/platform.js";

// 布局分发：移动平台（手机/平板触屏 UA）→ MobileLayout（三页左右滑动），其余 → DesktopLayout（三栏）。
// 判定逻辑已提到 theme/platform.js（与字号档位同源，?layout=mobile|desktop 一处强制两处生效）。
export default function Layout() {
  return isMobilePlatform() ? <MobileLayout /> : <DesktopLayout />;
}
