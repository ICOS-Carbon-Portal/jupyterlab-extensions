import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';

import { INotebookTracker, NotebookActions } from '@jupyterlab/notebook';
import { PageConfig } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

const tracker: JupyterFrontEndPlugin<void> = {
  id: '@icos-ext/tracker',
  autoStart: true,
  requires: [INotebookTracker],
  activate: (app: JupyterFrontEnd, notebooks: INotebookTracker) => {
    const settings = ServerConnection.makeSettings();
    const trackUrl = PageConfig.getBaseUrl() + 'icos-ext/track';
    const username = PageConfig.getOption('hubUser') || '';

    NotebookActions.executed.connect((_, args) => {
      // NotebookActions.executed reports the Notebook content widget; the
      // file path lives on the panel that wraps it.
      const panel = notebooks.find(p => p.content === args.notebook);
      if (!panel) {
        return;
      }
      const notebookPath = panel.context.path;
      ServerConnection.makeRequest(
        trackUrl,
        {
          method: 'POST',
          body: JSON.stringify({
            notebook: notebookPath,
            username,
            url: window.location.href
          })
        },
        settings
      ).catch(error => console.debug('Tracker: could not report ' + notebookPath, error));
    });
  }
};

export default tracker;
