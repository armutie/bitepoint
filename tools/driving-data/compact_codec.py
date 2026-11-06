"""Standard-library codec shared by the standalone decoder and local trainer."""
import array
import struct

ENCODING='learning-compact-v2'
EGO_FIELDS=['simTick','own.x','own.y','own.yaw','own.vx','own.vy','own.r','own.steer','own.slipF','own.slipR',
 'own.appliedSteer','own.appliedPedal','own.carImpulse','own.wallImpulse','own.nextOffTrack','own.lapValid','own.nextLapValid',
 'own.timingArmed','own.completedLapTime','own.penaltySeconds']
RIVAL_FIELDS=['forward','left','vForward','vLeft','heading','present']
EGO_STRIDE=len(EGO_FIELDS)

def columns(rivals):
    return EGO_FIELDS+[f'rival{i}.{name}' for i in range(rivals) for name in RIVAL_FIELDS]

def unpack(raw,rows,stride,rivals):
    count=(stride-EGO_STRIDE)//6
    if type(rows) is not int or not 1<=rows<=65535 or stride!=EGO_STRIDE+count*6 or not 0<=count<=7:
        raise ValueError('Invalid compact shape')
    seen=set()
    for rival in rivals:
        k,n=rival['index'],rival['count']
        if type(k) is not int or type(n) is not int or not 0<=k<count or k in seen or not 1<=n<=rows:
            raise ValueError('Invalid compact rival')
        seen.add(k)
    if len(raw)!=rows*EGO_STRIDE*4+sum(r['count']*22 for r in rivals):
        raise ValueError('Compact block length mismatch')
    result=array.array('f',[0])*(rows*stride);offset=0
    for c in range(EGO_STRIDE):
        values=struct.unpack_from(f'<{rows}f',raw,offset);offset+=rows*4
        for r,v in enumerate(values):result[r*stride+c]=v
    for rival in rivals:
        k,n=rival['index'],rival['count'];indices=struct.unpack_from(f'<{n}H',raw,offset);offset+=n*2
        if any(r>=rows for r in indices) or any(a>=b for a,b in zip(indices,indices[1:])):
            raise ValueError('Invalid sparse row indices')
        for r in indices:result[r*stride+EGO_STRIDE+k*6+5]=1
        for c in range(5):
            values=struct.unpack_from(f'<{n}f',raw,offset);offset+=n*4
            for r,v in zip(indices,values):result[r*stride+EGO_STRIDE+k*6+c]=v
    return result

def pack(values,rows,stride):
    if not 1<=rows<=65535 or stride<EGO_STRIDE or (stride-EGO_STRIDE)%6 or (stride-EGO_STRIDE)//6>7:
        raise ValueError('Invalid compact shape')
    parts=[];rivals=[]
    for c in range(EGO_STRIDE):parts.append(struct.pack(f'<{rows}f',*(values[r*stride+c] for r in range(rows))))
    for k in range((stride-EGO_STRIDE)//6):
        indices=[r for r in range(rows) if values[r*stride+EGO_STRIDE+k*6+5]==1]
        if not indices:continue
        n=len(indices);rivals.append(dict(index=k,count=n));parts.append(struct.pack(f'<{n}H',*indices))
        for c in range(5):parts.append(struct.pack(f'<{n}f',*(values[r*stride+EGO_STRIDE+k*6+c] for r in indices)))
    return b''.join(parts),rivals
