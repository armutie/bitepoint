"""Stream/verify a .bpt export. Usage: python decode.py recording.bpt [--jsonl frames.jsonl]."""
import argparse, gzip, hashlib, json, math, struct, sys, re, importlib.util,os
from pathlib import Path
_spec=importlib.util.spec_from_file_location('bpt_compact',Path(__file__).with_name('compact_codec.py'))
compact_codec=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(compact_codec)

def file_path(path):
    """Keep content-addressed filenames usable in deep Windows workspaces."""
    value=str(Path(path).absolute())
    if os.name=='nt' and not value.startswith('\\\\?\\'):
        value='\\\\?\\UNC\\'+value[2:] if value.startswith('\\\\') else '\\\\?\\'+value
    return Path(value)

def records(path):
    with Path(path).open('rb') as stream:
        if stream.read(8)!=b'BPTREC1\n':raise ValueError('Not a Bitepoint driving archive')
        ended=False
        while prefix:=stream.read(8):
            if len(prefix)!=8:raise ValueError('Truncated record prefix')
            header_size,payload_size=struct.unpack('<II',prefix)
            if header_size>16*1024*1024 or payload_size>64*1024*1024:raise ValueError('Unreasonable archive record size')
            header=stream.read(header_size);payload=stream.read(payload_size)
            if len(header)!=header_size or len(payload)!=payload_size:raise ValueError('Truncated archive record')
            record=json.loads(header)
            if ended:raise ValueError('Data follows archive end')
            if record['kind']=='archive-end':ended=True
            yield record,payload
        if not ended:raise ValueError('Archive end marker missing')

def verify_checksum(raw,expected):
    if expected.startswith('sha256:'):actual='sha256:'+hashlib.sha256(raw).hexdigest()
    elif expected.startswith('fnv1a32:'):
        h=2166136261
        for byte in raw:h=((h^byte)*16777619)&0xffffffff
        actual=f'fnv1a32:{h:08x}'
    else:raise ValueError('Unknown checksum scheme')
    if actual!=expected:raise ValueError('Telemetry checksum mismatch')

def resolve_asset(asset,archive):
    ref=asset.get('trackRef')
    if ref is None:return asset
    name=ref.get('file','')
    if not re.fullmatch(r'bitepoint-map-(?:sha256-[a-f0-9]{64}|fnv1a32-[a-f0-9]{8})\.json',name):
        raise ValueError('Unsafe or invalid shared-map reference')
    parent=Path(archive).resolve().parent;source=parent/name
    if source.resolve().parent!=parent:raise ValueError('Shared map must stay beside its recording')
    raw=file_path(source).read_bytes();verify_checksum(raw,ref['checksum'])
    return dict(asset,track=json.loads(raw))

def decode(path,output=None):
    assets={};sessions={};counts={};chunks={};total=0
    for record,payload in records(path):
        kind=record['kind']
        if kind=='asset':assets[record['id']]=resolve_asset(record['asset'],path)
        elif kind=='session':
            s=record['session'];sessions[s['id']]=s;counts[s['id']]=0;chunks[s['id']]=0
            if output:output.write(json.dumps({'kind':'session','session':s,'asset':assets[s['assetId']]})+'\n')
        elif kind=='chunk':
            sid=record['sessionId'];s=sessions[sid];asset=assets[s['assetId']]
            if record['index']!=chunks[sid] or record['firstTick']!=counts[sid]:raise ValueError('Non-contiguous recording')
            rows,stride=record['rows'],record['stride'];columns=asset['columns']
            if stride!=len(columns):raise ValueError('Schema/stride mismatch')
            raw=gzip.decompress(payload) if record['gzip'] else payload
            verify_checksum(raw,record['checksum'])
            compact=asset.get('encoding')==compact_codec.ENCODING
            decoded=compact_codec.unpack(raw,rows,stride,record.get('rivals',[])) if compact else None
            if not compact and len(raw)!=rows*stride*8:raise ValueError('Sample block length mismatch')
            if output:
                for r in range(rows):
                    values={}
                    for c,key in enumerate(columns):
                        value=decoded[r*stride+c] if compact else struct.unpack_from('<d',raw,(c*rows+r)*8)[0]
                        values[key]=value if math.isfinite(value) else None
                    output.write(json.dumps({'kind':'frame','sessionId':sid,'sample':values},allow_nan=False)+'\n')
                output.write(json.dumps({'kind':'chunk-terminal','sessionId':sid,'tick':record['firstTick']+rows,'states':record['terminalStates']},allow_nan=False)+'\n')
            counts[sid]+=rows;chunks[sid]+=1;total+=rows
        elif kind=='event':
            if output:output.write(json.dumps(record)+'\n')
        elif kind=='session-end':
            if counts[record['id']]!=record['frames'] or chunks[record['id']]!=record['chunks']:raise ValueError('Session counts disagree')
        elif kind not in ['manifest','archive-end']:raise ValueError('Unknown archive record')
    return {'sessions':len(sessions),'frames':total,'seconds':total/60,'chunks':sum(chunks.values()),'verified':True}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('archive');parser.add_argument('--jsonl')
    args=parser.parse_args()
    if args.jsonl:
        target=Path(args.jsonl)
        # Never replace an existing training export accidentally.
        with target.open('x',encoding='utf-8') as output:result=decode(args.archive,output)
    else:result=decode(args.archive)
    print(json.dumps(result,indent=2))
