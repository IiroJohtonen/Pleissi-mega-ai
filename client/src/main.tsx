import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "@fontsource-variable/inter";
import "./tokens.css";
import "./styles.css";
import "./styles-dark.css";
import "./styles-dark-overrides.css";
import { applyTheme, storedTheme } from "./theme";

// Teema asetetaan ennen ensimmäistä piirtoa, jotta sivu ei välähdä väärän värisenä.
applyTheme(storedTheme());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
