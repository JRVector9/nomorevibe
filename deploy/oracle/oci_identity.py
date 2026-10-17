"""Read this instance's OCI IMDSv2 identity and compare it with the root-approved record.

The metadata service is the fixed link-local endpoint. No proxy, redirect or alternative URL is honored.
A matching record is host identity evidence for the launcher only; it is not DB/model/workload readiness.
"""
import argparse
import http.client
import json
from pathlib import Path
import re
import sys
import time

from release_contract import exact, load_json, validate_host


IMDS_HOST = '169.254.169.254'
IMDS_PATH = '/opc/v2/instance/'
MAX_METADATA_BYTES = 64 * 1024
TIMEOUT_SECONDS = 2.0
TARGET = {'tenancy': 'surfguide', 'region': 'ap-osaka-1', 'instance': 'osaka-smoke'}
APPROVED_KEYS = ('version', 'tenancy', 'region', 'instance', 'tenancyOcid', 'compartmentOcid', 'instanceOcid', 'shape')
SUFFIX = r'[a-z0-9]{6,120}'


def fetch_instance_metadata(host=IMDS_HOST, port=80, timeout=TIMEOUT_SECONDS, max_bytes=MAX_METADATA_BYTES):
    """One bounded IMDSv2 GET. Tests pass a loopback host; the launcher/CLI never expose this parameter."""
    deadline = time.monotonic() + timeout
    connection = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        connection.request('GET', IMDS_PATH, headers={'Authorization': 'Bearer Oracle', 'Accept': 'application/json'})
        response = connection.getresponse()
        # http.client never follows a redirect; every non-200 (including 3xx) is rejected.
        if response.status != 200:
            raise ValueError('oci_metadata_status_rejected')
        length = response.getheader('Content-Length')
        if length is not None and (not length.isdigit() or int(length) > max_bytes):
            raise ValueError('oci_metadata_too_large')
        body = bytearray()
        while True:
            if time.monotonic() > deadline:
                raise ValueError('oci_metadata_timeout')
            chunk = response.read1(4096)
            if not chunk:
                break
            body += chunk
            if len(body) > max_bytes:
                raise ValueError('oci_metadata_too_large')
        return load_json(bytes(body))
    except (OSError, http.client.HTTPException) as error:
        raise ValueError('oci_metadata_unavailable') from error
    finally:
        connection.close()


def _ocid(value, prefixes):
    if type(value) is not str or not any(value.startswith(prefix) and re.fullmatch(SUFFIX, value[len(prefix):])
                                         for prefix in prefixes):
        raise ValueError('invalid_oracle_ocid')
    return value


def validate_approved(value):
    exact(value, APPROVED_KEYS)
    if (type(value['version']) is not int or value['version'] != 1
            or {key: value[key] for key in TARGET} != TARGET):
        raise ValueError('oracle_host_identity_mismatch')
    _ocid(value['tenancyOcid'], ('ocid1.tenancy.oc1..',))
    _ocid(value['instanceOcid'], ('ocid1.instance.oc1.ap-osaka-1.',))
    # A root-compartment instance reports the tenancy OCID as its compartment.
    if value['compartmentOcid'] != value['tenancyOcid']:
        _ocid(value['compartmentOcid'], ('ocid1.compartment.oc1..',))
    if type(value['shape']) is not str or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.]{2,63}', value['shape']):
        raise ValueError('invalid_oracle_shape')
    return value


def observed_identity(metadata):
    if type(metadata) is not dict:
        raise ValueError('invalid_oci_metadata')
    info = metadata.get('regionInfo')
    region = metadata.get('canonicalRegionName')
    if type(info) is dict and info.get('regionIdentifier') is not None and info.get('regionIdentifier') != region:
        raise ValueError('oci_metadata_region_conflict')
    observed = {'tenancyOcid': metadata.get('tenantId'), 'compartmentOcid': metadata.get('compartmentId'),
                'instanceOcid': metadata.get('id'), 'region': region, 'displayName': metadata.get('displayName'),
                'shape': metadata.get('shape')}
    if any(type(value) is not str or not value for value in observed.values()):
        raise ValueError('invalid_oci_metadata')
    return observed


def validate_identity(approved, observed):
    """Return the existing strict host record only when every approved field equals IMDS."""
    approved = validate_approved(approved)
    exact(observed, ('tenancyOcid', 'compartmentOcid', 'instanceOcid', 'region', 'displayName', 'shape'))
    if (observed['tenancyOcid'] != approved['tenancyOcid'] or observed['compartmentOcid'] != approved['compartmentOcid']
            or observed['instanceOcid'] != approved['instanceOcid'] or observed['region'] != approved['region']
            or observed['displayName'] != approved['instance'] or observed['shape'] != approved['shape']):
        raise ValueError('oracle_host_identity_mismatch')
    record = {'version': 1, 'tenancy': approved['tenancy'], 'region': approved['region'], 'instance': approved['instance'],
              'tenancyOcid': approved['tenancyOcid'], 'instanceOcid': approved['instanceOcid']}
    validate_host(record, record)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--approved', required=True, type=Path)
    args = parser.parse_args()
    try:
        record = validate_identity(load_json(args.approved.read_bytes()), observed_identity(fetch_instance_metadata()))
        # Output is the existing host-record shape for manage_release --observed-host.
        print(json.dumps(record, sort_keys=True))
    except Exception as error:
        print(json.dumps({'code': 'oracle_identity_unverified', 'reason': str(error) if isinstance(error, ValueError) else type(error).__name__}),
              file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
