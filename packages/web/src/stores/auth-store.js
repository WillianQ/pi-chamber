// 登录态 store：token 持久化 / 门控 / logout
// authed: null=启动探活中, true=已登录（此时才 connect），false=未登录
import { create } from "zustand";
import { getToken, setToken, login as apiLogin, me as apiMe } from "../api.js";
import { connect, disconnect } from "../bus.js";

export const useAuthStore = create((set) => ({
  authed: null,
  loginError: null,

  /** 应用启动：本地有 token 则 /api/me 探活，通过才连 WS */
  async bootstrap() {
    const token = getToken();
    if (!token) {
      set({ authed: false });
      return;
    }
    const ok = await apiMe().catch(() => false);
    if (ok) {
      set({ authed: true });
      connect(token);
    } else {
      setToken(null);
      set({ authed: false });
    }
  },

  async login(password) {
    try {
      const token = await apiLogin(password);
      setToken(token);
      set({ authed: true, loginError: null });
      connect(token);
    } catch (e) {
      set({ loginError: e?.message || "登录失败" });
    }
  },

  logout() {
    disconnect();
    setToken(null);
    set({ authed: false });
  },
}));
