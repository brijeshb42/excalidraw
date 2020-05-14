import throttle from "lodash.throttle";
import { loadFromBlob } from "./data";
import { exportToCanvas, exportToSvg } from "./scene/export";
import App from "./components/App";
import { globalSceneState } from "./scene";
import { serializeAsJSON } from "./data/json";
import { KEYS } from "./keys";
import { NonDeletedExcalidrawElement } from "./element/types";
import { AppProps, AppState } from "./types";

type MessageType = "load" | "save" | "export" | "autosave" | "deleteShape";

interface IMessageData {
  source: "vscode-excalidraw";
  type: MessageType;
  data?: any;
  actionId?: string;
  autosave?: 1 | 0;
  scale?: number;
}

export interface PostMessageListener {
  dispose: Function;
  start: Function;
  didUpdate(
    prevProps: AppProps,
    prevState: AppState,
    props: AppProps,
    state: AppState,
  ): void;
  handleKeyDown(ev: KeyboardEvent): boolean;
}

export interface IPostMessageData {
  type: "init" | MessageType;
  actionId?: string;
  data?: any;
}

function postMessage(data: IPostMessageData) {
  window.parent.postMessage(data, "*");
}

function exportToPng(
  elements: readonly NonDeletedExcalidrawElement[],
  appState: AppState,
  canvas: HTMLCanvasElement,
  scale: number = 1,
): Promise<string | ArrayBuffer | null> {
  return new Promise((resolve, reject) => {
    const tmpCanvas = exportToCanvas(elements, appState, {
      exportBackground: appState.exportBackground,
      viewBackgroundColor: appState.viewBackgroundColor,
      exportPadding: 10,
      scale,
      shouldAddWatermark: false,
    }) as HTMLCanvasElement;
    tmpCanvas.style.display = "none";
    document.body.appendChild(tmpCanvas);

    try {
      tmpCanvas.toBlob((blob) => {
        if (!blob) {
          reject();
          return;
        }

        const reader = new FileReader();
        reader.onloadend = () => {
          resolve(reader.result);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (ex) {
      reject(ex);
    }
  });
}

function exportToSVG(
  elements: readonly NonDeletedExcalidrawElement[],
  appState: AppState,
) {
  return exportToSvg(elements, {
    exportBackground: !!appState.viewBackgroundColor,
    exportPadding: 10,
    viewBackgroundColor: appState.viewBackgroundColor,
    shouldAddWatermark: false,
  }).outerHTML;
}

export function addPostMessageSupport(app: App): PostMessageListener {
  let started = false;
  let autosave = false;

  function handleMessage(ev: MessageEvent) {
    if (!started || !app.props.isEmbed || app.unmounted) {
      return;
    }

    let messageData = ev.data;

    if (!messageData) {
      return;
    }

    if (typeof messageData === "object") {
      messageData = ev.data as IMessageData;
    } else if (typeof messageData === "string") {
      try {
        messageData = JSON.parse(ev.data) as IMessageData;
      } catch (ex) {
        console.error(ex);
        return;
      }
    }

    if (messageData.source !== "vscode-excalidraw") {
      return;
    }

    handleVscodeMessage(messageData);
  }

  function getJSON() {
    return serializeAsJSON(
      globalSceneState.getElementsIncludingDeleted(),
      app.state,
    );
  }

  async function handleVscodeMessage(msg: IMessageData) {
    switch (msg.type) {
      case "load": {
        if (msg.autosave === 1) {
          autosave = true;
        }

        if (!msg.data) {
          return;
        }

        // this is duplicate code copied from App.tsx
        app.setState({ isLoading: true });
        const blob = new Blob([msg.data], { type: "application/json" });
        loadFromBlob(blob)
          .then(({ elements, appState }) =>
            app.syncActionResult({
              elements,
              appState: {
                ...(appState || app.state),
                isLoading: false,
              },
              commitToHistory: false,
            }),
          )
          .catch((error) => {
            app.setState({ isLoading: false, errorMessage: error.message });
          });
        break;
      }
      case "save": {
        if (msg.data === "raw") {
          postMessage({
            type: "save",
            data: getJSON(),
            actionId: msg.actionId,
          });
        } else {
          if (!app.canvas) {
            return;
          }

          if (msg.data === "png") {
            const data = await exportToPng(
              globalSceneState.getElements(),
              app.state,
              app.canvas,
              msg.scale || 1,
            );

            if (!data) {
              return;
            }

            postMessage({
              type: "export",
              data,
              actionId: msg.actionId,
            });
          } else if (msg.data === "svg") {
            const data = exportToSVG(globalSceneState.getElements(), app.state);

            if (!data) {
              return;
            }

            postMessage({
              type: "export",
              data,
              actionId: msg.actionId,
            });
          }
        }
        break;
      }
      case "deleteShape": {
        app.actionManager.executeAction(
          app.actionManager.actions.deleteSelectedElements,
        );
        postMessage({
          type: msg.type,
          actionId: msg.actionId,
        });
        break;
      }
      default:
        break;
    }
  }

  function sendCurrentState() {
    if (!autosave) {
      return;
    }

    postMessage({
      type: "autosave",
      data: getJSON(),
    });
  }

  const throttledAutosave = throttle(sendCurrentState, 300);

  function didAppUpdate(
    prevProps: AppProps,
    prevState: AppState,
    props: AppProps,
    state: AppState,
  ) {
    if (!started || !app.props.isEmbed || app.unmounted) {
      return;
    }

    const { isLoading: prevIsLoading } = prevState;
    const { isLoading } = state;

    if (!isLoading && prevIsLoading) {
      const data: IPostMessageData = {
        type: "init",
      };

      postMessage(data);
    }

    throttledAutosave();
  }

  function handleKeyDown(ev: KeyboardEvent): boolean {
    if (ev.key === "w" && ev[KEYS.CTRL_OR_CMD as "metaKey" | "ctrlKey"]) {
      return true;
    }

    if (ev.key === "s" && ev[KEYS.CTRL_OR_CMD as "metaKey" | "ctrlKey"]) {
      postMessage({
        type: "save",
      });
      return true;
    }

    if (ev.key === "Delete") {
      return true;
    }

    return false;
  }

  return {
    dispose() {
      if (!started) {
        return;
      }

      throttledAutosave.flush();
      window.removeEventListener("message", handleMessage);
    },
    start() {
      started = true;
      const canvasIsland = document.querySelector(
        '[aria-labelledby="canvasActions-title"]',
      );
      const btns = Array.prototype.slice.call(
        canvasIsland!.querySelectorAll(".ToolIcon_type_button"),
      );
      const toHideElements = Array.prototype.slice.call(
        document.querySelectorAll(
          ".layer-ui__wrapper__github-corner, .encrypted-icon",
        ),
      );
      const elements = btns.concat(toHideElements);
      elements.forEach((e) => {
        (e as HTMLElement).style.display = "none";
      });
      window.addEventListener("message", handleMessage);
    },
    didUpdate: didAppUpdate,
    handleKeyDown,
  };
}
