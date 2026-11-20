"""Shared Claude API client for this project.

Usage:
    from claude_client import client, ask
    print(ask("Summarize what a resistivity log measures."))

Run directly to check that the API key works:
    python claude_client.py
"""

from pathlib import Path

import anthropic
from dotenv import load_dotenv

# Load ANTHROPIC_API_KEY from the .env file next to this module.
load_dotenv(Path(__file__).with_name(".env"))

MODEL = "claude-opus-5-5"

client = anthropic.Anthropic()


def ask(prompt: str, system: str | None = None, max_tokens: int = 16000) -> str:
    """Send a single prompt to Claude and return the text of the reply."""
    kwargs = {"system": system} if system else {}
    response = client.messages.create(
        model=MODEL,
        max_tokens=max_tokens,
        messages=[{"role": "user", "content": prompt}],
        **kwargs,
    )
    if response.stop_reason == "refusal":
        raise RuntimeError(f"Request refused: {response.stop_details}")
    return "".join(b.text for b in response.content if b.type == "text")


if __name__ == "__main__":
    try:
        print(ask("Reply with exactly: API key works."))
    except anthropic.AuthenticationError:
        print("Authentication failed: check ANTHROPIC_API_KEY in .env")
    except anthropic.APIConnectionError:
        print("Network error: could not reach the Anthropic API")
