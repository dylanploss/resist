"""Pytest setup: tests never touch the committed snapshot or Cosmos unless a test opts in explicitly."""

import os

os.environ["RESIST_STORE"] = "memory"
os.environ.setdefault("COSMOS_ENABLED", "false")
