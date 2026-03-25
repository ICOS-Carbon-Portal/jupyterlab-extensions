import ipaddress
import json
import logging
import os
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
        ip = self.request.headers.get("X-Forwarded-For", self.request.remote_ip).split(",")[0].strip()

        params = {
            "idsite": MATOMO_SITE_ID,
            "rec": "1",
            "action_name": f"{username}:{notebook}",
            "url": url,
            "uid": f"{username}:{notebook}",
            "ua": self.request.headers.get("User-Agent", ""),
        }

        try:
            is_public = not ipaddress.ip_address(ip).is_private
        except ValueError:
            is_public = False

        if is_public:
            token_auth = os.getenv("MATOMO_TOKEN_AUTH", "")
            if token_auth:
                params["cip"] = ip
                params["token_auth"] = token_auth

        try:
            client = AsyncHTTPClient()
            await client.fetch(f"{MATOMO_URL}?{urllib.parse.urlencode(params)}", raise_error=False)
        except Exception as e:
            log.warning("Matomo tracking failed: %s", e)

        self.finish(json.dumps({"status": "ok"}))


def setup_handlers(web_app):
    base_url = web_app.settings.get("base_url", "/")
    handlers = [
        (url_path_join(base_url, "icos-ext", "track"), TrackHandler)
    ]
    web_app.add_handlers(".*$", handlers)
