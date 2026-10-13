import "./lib/schema-runtime";
import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/golos-text/400.css";
import "@fontsource/golos-text/500.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./styles.css";
import "./components/brand.css";
import App from "./App";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
