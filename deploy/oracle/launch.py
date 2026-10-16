#!/usr/bin/env python3
"""Inactive launch boundary until the final PR10/host preflight is integrated."""
import argparse
import json
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--role', required=True, choices=(
        'crawler', 'reviewer', 'publisher', 'text', 'maintenance', 'translation',
        'product-health', 'site-evidence', 'official-news', 'scheduler'))
    parser.parse_args()
    # No flag, environment variable, supplied receipt or local marker can open this phase.
    print(json.dumps({'code': 'oracle_runtime_preflight_unavailable'}), file=sys.stderr)
    return 78


if __name__ == '__main__':
    raise SystemExit(main())
