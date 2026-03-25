import json
import logging
import urllib.parse
from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join
from tornado import web
from tornado.httpclient import AsyncHTTPClient

log = logging.getLogger(__name__)

MATOMO_URL = "https://matomo.icos-cp.eu/matomo.php"
MATOMO_SITE_ID = "10"


class TrackHandler(APIHandler):
    @web.authenticated
    async def post(self):
        body = json.loads(self.request.body)
        notebook = body.get("notebook", "")
        username = body.get("username", "")
        url = body.get("url", "") or "https://ganymede.icos-cp.eu"

        params = urllib.parse.urlencode({
            "idsite": MATOMO_SITE_ID,
            "rec": "1",
            "action_name": f"{username}:{notebook}",
            "url": url,
            "uid": f"{username}:{notebook}",
            "ua": self.request.headers.get("User-Agent", ""),
        })

        try:
            client = AsyncHTTPClient()
            await client.fetch(f"{MATOMO_URL}?{params}", raise_error=False)
        except Exception as e:
            log.warning("Matomo tracking failed: %s", e)

        self.finish(json.dumps({"status": "ok"}))


def setup_handlers(web_app):
    base_url = web_app.settings.get("base_url", "/")
    handlers = [
        (url_path_join(base_url, "icos-ext", "track"), TrackHandler)
    ]
    web_app.add_handlers(".*$", handlers)
