import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { applyThemeCss } from "./theme/css.js";
import "./index.css";

applyThemeCss(); // tokens → :root CSS 变量（先于首次渲染，字符串样式靠它消费 token）

createRoot(document.getElementById("root")).render(<App />);
