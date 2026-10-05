import { createRoot } from "react-dom/client";
import App from "./App";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "katex/dist/katex.min.css";
import "./generated/impo.css";
createRoot(document.getElementById("root")!).render(<App />);
