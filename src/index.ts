import { createElement } from "react";
import ReactDOM from "react-dom";

import { IsMobileProvider } from "./is-mobile";
import App from "./components/App";

import "./css/styles.scss";

const rootElement = document.getElementById("root");
const isEmbed = window.location.search.indexOf("embed=1") >= 0;

ReactDOM.render(
  createElement(IsMobileProvider, null, createElement(App, { isEmbed })),
  rootElement,
);

declare global {
  interface Window {
    isEmbed: boolean;
  }
}

if (isEmbed) {
  rootElement!.classList.add("is-embed");
}
