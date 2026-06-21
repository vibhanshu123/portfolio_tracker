#!/bin/bash
cd "$(dirname "$0")"
[ -f .env ] && export $(grep -v '^#' .env | xargs)
/Library/Frameworks/Python.framework/Versions/3.13/bin/python3 -m uvicorn main:app --host 0.0.0.0 --port 8001 --reload
