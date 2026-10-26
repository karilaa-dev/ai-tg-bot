import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread

import numpy as np
import pandas as pd
import requests
import yaml
from bs4 import BeautifulSoup
from matplotlib.backends.backend_agg import FigureCanvasAgg
from matplotlib.figure import Figure
from PIL import Image


def main():
    requirements = Path(__file__).with_name("requirements.txt").read_text()
    versions = {}
    for name, expected in re.findall(r"^([\w-]+)==([^\s]+)", requirements, re.MULTILINE):
        actual = version(name)
        assert actual == expected, f"{name}: expected {expected}, found {actual}"
        versions[name] = actual

    with TemporaryDirectory(prefix="python-contract-") as directory:
        root = Path(directory)
        image_path = root / "image.png"
        Image.new("RGB", (4, 3), (12, 34, 56)).resize((2, 2)).save(image_path)
        with Image.open(image_path) as image:
            assert image.format == "PNG"
            assert image.size == (2, 2)
            assert image.getpixel((0, 0)) == (12, 34, 56)

        values = np.array([1, 2, 3])
        assert np.dot(values, values) == 14
        frame = pd.read_csv(StringIO("group,value\na,1\na,2\nb,3\n"))
        assert frame.groupby("group")["value"].sum().to_dict() == {"a": 3, "b": 3}
        csv_path = root / "data.csv"
        frame.to_csv(csv_path, index=False)
        assert pd.read_csv(csv_path).equals(frame)

        figure = Figure(figsize=(2, 2), dpi=50)
        FigureCanvasAgg(figure)
        figure.subplots().plot(values, values**2)
        chart_path = root / "chart.png"
        figure.savefig(chart_path)
        with Image.open(chart_path) as chart:
            assert chart.format == "PNG"
            assert chart.size == (100, 100)
            assert chart.convert("L").getextrema()[0] < 255

    soup = BeautifulSoup('<main><a href="/tools">Sandbox &amp; Python</a></main>', "html.parser")
    link = soup.select_one("main > a")
    assert link is not None
    assert (link["href"], link.get_text()) == ("/tools", "Sandbox & Python")
    config = yaml.safe_load("libraries:\n  - pillow\n  - requests\nenabled: true\n")
    assert config == {"libraries": ["pillow", "requests"], "enabled": True}
    assert yaml.safe_load(yaml.safe_dump(config)) == config

    server = ThreadingHTTPServer(("127.0.0.1", 0), RequestHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with requests.Session() as session:
            session.trust_env = False
            response = session.get(
                f"http://127.0.0.1:{server.server_port}/python-contract",
                params={"value": 42},
                timeout=5,
            )
            response.raise_for_status()
            assert response.json() == {"path": "/python-contract?value=42", "ok": True}
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    print(f"Default Python libraries contract passed: {json.dumps(versions, sort_keys=True)}")


class RequestHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"path": self.path, "ok": True}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    main()
