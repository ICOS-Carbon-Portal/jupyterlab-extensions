import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { Dialog, ISplashScreen } from '@jupyterlab/apputils';
import { Throttler } from '@lumino/polling';
import { DisposableDelegate } from '@lumino/disposable';

/* ------------------------------------------
   Splash Screen
------------------------------------------- */

const SPLASH_RECOVER_TIMEOUT = 12000;

namespace CommandIDs {
  export const loadState = 'apputils:load-statedb';
  export const print = 'apputils:print';
  export const reset = 'apputils:reset';
  export const resetOnLoad = 'apputils:reset-on-load';
  export const runFirstEnabled = 'apputils:run-first-enabled';
}

const splash: JupyterFrontEndPlugin<ISplashScreen> = {
  id: '@icos-ext/splash',
  autoStart: true,
  provides: ISplashScreen,
  activate: (app: JupyterFrontEnd) => {
    const { commands, restored } = app;

    const splash = document.createElement('div');
    splash.id = 'icos-splash';
    splash.innerHTML = 'ICOS';

    const verticalLine = document.createElement('div');
    verticalLine.classList.add('vertical-line');
    splash.appendChild(verticalLine);

    const leftSide = document.createElement('div');
    splash.appendChild(leftSide);

    const circleContainer = document.createElement('div');
    circleContainer.id = 'circle-container';
    leftSide.appendChild(circleContainer);

    const leftSideText = document.createElement('div');
    leftSideText.id = 'left-side-text';
    leftSideText.innerHTML = 'CARBON<br>PORTAL';
    leftSide.appendChild(leftSideText);

    ['circle-1', 'circle-2', 'circle-3'].forEach(id => {
      const c = document.createElement('div');
      c.id = id;
      circleContainer.appendChild(c);
    });

    let dialog: Dialog<unknown> | null = null;
    const recovery = new Throttler(
      async () => {
        if (dialog) return;
        dialog = new Dialog({
          title: 'Loading...',
          body: `The loading screen is taking a long time.
Would you like to clear the workspace or keep waiting?`,
          buttons: [
            Dialog.cancelButton({ label: 'Keep Waiting' }),
            Dialog.warnButton({ label: 'Clear Workspace' })
          ]
        });

        try {
          const result = await dialog.launch();
          dialog.dispose();
          dialog = null;
          if (result.button.accept && commands.hasCommand(CommandIDs.reset)) {
            return commands.execute(CommandIDs.reset);
          }
          requestAnimationFrame(() => void recovery.invoke().catch(() => undefined));
        } catch { /* no-op */ }
      },
      { limit: SPLASH_RECOVER_TIMEOUT, edge: 'trailing' }
    );

    let splashCount = 0;
    return {
      show: () => {
        splash.classList.remove('splash-fade');
        splashCount++;
        document.body.appendChild(splash);
        void recovery.invoke().catch(() => undefined);
        return new DisposableDelegate(async () => {
          const minDisplay = new Promise<void>(resolve =>
            setTimeout(resolve, 1500)
          );
          await Promise.all([restored, minDisplay]);
          if (--splashCount === 0) {
            void recovery.stop();
            if (dialog) { dialog.dispose(); dialog = null; }
            splash.classList.add('splash-fade');
            setTimeout(() => document.body.removeChild(splash), 200);
          }
        });
      }
    };
  }
};

export default splash;
