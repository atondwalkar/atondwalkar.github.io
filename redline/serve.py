#!/usr/bin/env python3
"""REDLINE dev server.

Code (HTML/JS/CSS) is served no-store so a reload can never show a stale
build. There are no binary assets — the whole game is generated at runtime.
"""
import base64
import os
import re
import time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

os.chdir(os.path.dirname(os.path.abspath(__file__)))

PORT = 8126
CODE_EXT = ('.html', '.js', '.json', '.css', '.mjs')
GIF_1PX = bytes.fromhex(
    '47494638396101000100800000000000ffffff21f90401000000'
    '002c00000000010001000002024401003b'
)


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        # A deliberately slow 1x1 image. The headless smoke test loads it so
        # the window 'load' event — and therefore the screenshot — waits for
        # the match simulation to finish.
        parts = urlparse(self.path)
        if parts.path == '/__delay':
            ms = int((parse_qs(parts.query).get('ms') or ['1000'])[0])
            time.sleep(min(max(ms, 0), 60000) / 1000)
            self.send_response(200)
            self.send_header('Content-Type', 'image/gif')
            self.send_header('Content-Length', str(len(GIF_1PX)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(GIF_1PX)
            return
        super().do_GET()

    def do_POST(self):
        """Results channel for the smoke test.

        The page POSTs its report to /__result and each frame dump to
        /__frame/<name>; both land in .test/. Reading them off disk is immune
        to whether this Firefox happens to be piping console.log to stdout,
        which it does not do reliably.
        """
        parts = urlparse(self.path)
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)
        os.makedirs('.test', exist_ok=True)
        if parts.path == '/__result':
            # Appended, not overwritten. The page posts its report when the run
            # ends and then posts again from the frame dump — a failure inside
            # it, or the extra lines the dump measures. Truncating on every
            # POST meant the last one silently replaced the whole report, which
            # looks exactly like the run never finished.
            with open(os.path.join('.test', 'result.txt'), 'ab') as f:
                f.write(body)
        elif parts.path.startswith('/__frame/'):
            name = re.sub(r'[^a-z0-9_-]', '', parts.path[len('/__frame/'):].lower())
            try:
                data = base64.b64decode(body.split(b',')[-1])
                with open(os.path.join('.test', 'frame_%s.png' % name), 'wb') as f:
                    f.write(data)
            except Exception:
                pass
        self.send_response(204)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def end_headers(self):
        # Strip the query first: "/?test=25&dump=1" ends in neither ".html"
        # nor "/", so without this the page itself was served cacheable — and
        # cached per query string, which pairs fresh JS with stale HTML.
        path = urlparse(self.path).path
        if path.endswith(CODE_EXT) or path.endswith('/'):
            self.send_header('Cache-Control', 'no-store, must-revalidate')
            self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, *args):
        pass   # keep the terminal quiet


if __name__ == '__main__':
    print(f'REDLINE serving on http://localhost:{PORT}')
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
