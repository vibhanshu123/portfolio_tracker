#!/bin/bash
cd "$(dirname "$0")"
/Library/Frameworks/Python.framework/Versions/3.13/bin/python3 -m uvicorn app:app --host 0.0.0.0 --port 8001 --reload
