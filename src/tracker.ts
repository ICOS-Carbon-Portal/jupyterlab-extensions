import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { INotebookTracker, NotebookActions } from '@jupyterlab/notebook';
import { PageConfig } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

/* ------------------------------------------
   Cell Execution Tracker
------------------------------------------- */

const tracker: JupyterFrontEndPlugin<void> = {
  id: '@icos-ext/tracker',
  autoStart: true,
  requires: [INotebookTracker],
  activate: (app: JupyterFrontEnd, notebooks: INotebookTracker) => {
    // The server settings, the endpoint and the Hub user are fixed for
    // the lifetime of the page, so they are read once here instead of
    // on every cell execution.
    const settings = ServerConnection.makeSettings();
    const trackUrl = PageConfig.getBaseUrl() + 'icos-ext/track';
    const username = PageConfig.getOption('hubUser') || '';

    NotebookActions.executed.connect((_, args) => {
      const panel = notebooks.find(p => p.content === args.notebook);
      if (!panel) {
        return;
      }
      const notebookPath = panel.context.path;
      ServerConnection.makeRequest(
        trackUrl,
        {
          method: 'POST',
          body: JSON.stringify({ notebook: notebookPath, username, url: window.location.href })
        },
        settings
      ).catch(() => undefined);
    });
  }
};

export default tracker;
