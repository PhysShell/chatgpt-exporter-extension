#!/usr/bin/env python3
"""
ChatGPT Export Processor
=========================
Converts chatgpt_export.json (downloaded by the Chrome extension)
into Markdown files, preserving the project folder structure.

Usage:
    python chatgpt_process_json.py

Place chatgpt_export.json in the same folder, or set JSON_FILE below.
"""

import json
import re
from datetime import datetime
from pathlib import Path

# ================================================================
# CONFIG
# ================================================================

JSON_FILE  = "chatgpt_export.json"   # Input JSON
OUTPUT_DIR = "chatgpt_export"        # Output folder

# ================================================================


def safe_filename(name: str, max_length: int = 80) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)
    name = name.strip(". ")
    return name[:max_length] if name else "Untitled"


def extract_messages(conv_data: dict) -> list:
    mapping      = conv_data.get("mapping", {})
    current_node = conv_data.get("current_node")
    if not mapping or not current_node:
        return []

    path    = []
    node_id = current_node
    visited = set()

    while node_id and node_id not in visited:
        visited.add(node_id)
        node = mapping.get(node_id, {})
        msg  = node.get("message")
        if msg:
            role    = msg.get("author", {}).get("role", "")
            content = msg.get("content", {})
            if role in ("user", "assistant") and content:
                text = _extract_text(content)
                if text.strip():
                    path.append({
                        "role": role,
                        "text": text.strip(),
                        "time": msg.get("create_time", 0),
                    })
        node_id = node.get("parent")

    path.reverse()
    return path


def _extract_text(content: dict) -> str:
    ct   = content.get("content_type", "text")
    text = ""
    if ct == "text":
        parts = content.get("parts", [])
        text  = "\n".join(str(p) for p in parts if isinstance(p, str))
    elif ct in ("multimodal_text", "code", "tether_browsing_display"):
        for part in content.get("parts", []):
            if isinstance(part, str):
                text += part + "\n"
            elif isinstance(part, dict):
                if part.get("content_type") == "image_asset_pointer":
                    text += "[Image]\n"
                elif "text" in part:
                    text += str(part["text"]) + "\n"
    return text


def conversation_to_markdown(conv_data: dict) -> str:
    title       = conv_data.get("title", "Untitled")
    create_time = conv_data.get("create_time", 0)
    update_time = conv_data.get("update_time", 0)
    conv_id     = conv_data.get("id", "")

    lines = [f"# {title}", ""]
    if create_time:
        dt = datetime.fromtimestamp(create_time)
        lines.append(f"**Created:** {dt.strftime('%Y-%m-%d %H:%M')}")
    if update_time and update_time != create_time:
        dt = datetime.fromtimestamp(update_time)
        lines.append(f"**Updated:** {dt.strftime('%Y-%m-%d %H:%M')}")
    if conv_id:
        lines.append(f"**ID:** `{conv_id}`")

    lines.extend(["", "---", ""])

    messages = extract_messages(conv_data)
    if not messages:
        lines.append("*(Empty or unreadable conversation)*")
    else:
        for msg in messages:
            lines.append("### You" if msg["role"] == "user" else "### ChatGPT")
            lines.append("")
            lines.append(msg["text"])
            lines.append("")
            lines.append("---")
            lines.append("")

    return "\n".join(lines)


def save_conversation(conv_data: dict, folder: Path) -> Path:
    title       = conv_data.get("title", "Untitled")
    create_time = conv_data.get("create_time", 0)
    date_prefix = (
        datetime.fromtimestamp(create_time).strftime("%Y-%m-%d")
        if create_time else "0000-00-00"
    )
    base_name = f"{date_prefix}_{safe_filename(title)}"
    filepath  = folder / f"{base_name}.md"
    counter   = 1
    while filepath.exists():
        filepath = folder / f"{base_name}_{counter}.md"
        counter += 1
    filepath.write_text(conversation_to_markdown(conv_data), encoding="utf-8")
    return filepath


def main():
    print("=" * 56)
    print("  ChatGPT Export Processor")
    print("=" * 56)

    json_path = Path(JSON_FILE)
    if not json_path.exists():
        print(f"\n[ERROR] Not found: {JSON_FILE}")
        print("  1. Open chatgpt.com in Chrome")
        print("  2. Click the ChatGPT Exporter extension icon")
        print("  3. Click 'Start Export' and wait for the download")
        print("  4. Move chatgpt_export.json here, then run this script")
        return

    print(f"\nLoading: {json_path.resolve()}")
    with open(json_path, encoding="utf-8") as f:
        data = json.load(f)

    projects      = data.get("projects", {})
    conversations = data.get("conversations", [])
    exported_at   = data.get("exported_at", "unknown")

    print(f"  Exported at:    {exported_at}")
    print(f"  Projects:       {len(projects)}")
    print(f"  Conversations:  {len(conversations)}")

    # Create folder structure
    output = Path(OUTPUT_DIR)
    output.mkdir(exist_ok=True)

    project_folders: dict[str, Path] = {}
    for pid, name in projects.items():
        folder = output / "Projects" / safe_filename(name)
        folder.mkdir(parents=True, exist_ok=True)
        project_folders[pid] = folder

    general_folder = output / "Conversations"
    general_folder.mkdir(exist_ok=True)

    print(f"\nProcessing {len(conversations)} conversations...")
    total  = len(conversations)
    saved  = 0
    errors = 0

    for i, conv in enumerate(conversations, 1):
        title        = conv.get("title", "Untitled")
        project_id   = conv.get("_project_id") or conv.get("project_id")
        project_name = conv.get("_project_name")

        if project_id and project_id in project_folders:
            folder   = project_folders[project_id]
            location = f"Projects/{project_name or project_id}"
        else:
            folder   = general_folder
            location = "Conversations"

        short = (title[:42] + "...") if len(title) > 45 else title
        print(f"  [{i:>4}/{total}] {short:<45} -> {location}")

        try:
            save_conversation(conv, folder)
            saved += 1
        except Exception as e:
            print(f"           [!] Error: {e}")
            errors += 1

    print("\n" + "=" * 56)
    print(f"  Done!  Saved: {saved}  |  Errors: {errors}")
    print(f"  Output folder: {output.resolve()}")
    print("=" * 56)


if __name__ == "__main__":
    main()
