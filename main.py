#!/usr/bin/env python3
"""Layaider entry point.

Evaluates the environment before starting services: if config.json is missing
or unconfigured, runs the interactive first-time initialization and exits with
activation instructions (guide 1.4); otherwise starts the server.
"""

import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(ROOT, "src"))

import config
import core


def main():
    cfg, configured = config.load_config(app_root=ROOT)
    if not configured:
        print("[Layaider First-Time Initialization]")
        config.run_first_time_init(app_root=ROOT, interactive=True)
        print("")
        print("Run `python3 main.py` again to start Layaider.")
        return
    core.run_server(cfg)


if __name__ == "__main__":
    main()
