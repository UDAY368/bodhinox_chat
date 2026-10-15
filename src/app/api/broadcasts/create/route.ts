import { NextResponse } from 'next/server';
import { requireSession, assertMutation } from '@/lib/auth/session';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { hasMinRole } from '@/lib/auth/roles';
import { toErrorResponse } from '@/lib/auth/account';
import { createCampaign, CAMPAIGN_LIMITS } from '@/lib/broadcasts/create-campaign';

export const runtime='nodejs';
async function readBody(request:Request):Promise<unknown>{
  if(!request.headers.get('content-type')?.includes('application/json'))throw new AuthError('JSON content required',400);
  const reader=request.body?.getReader();if(!reader)throw new AuthError('Campaign body required',400);
  const chunks:Uint8Array[]=[];let bytes=0;
  for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;
    if(bytes>CAMPAIGN_LIMITS.bodyBytes){await reader.cancel();throw new AuthError('Campaign request is too large',413);}
    chunks.push(chunk.value);
  }
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new AuthError('Invalid JSON campaign body',400);}
}
export async function POST(request:Request){
  try{
    const session=await requireSession(request);
    if(!hasMinRole(session.role,'agent'))throw new ForbiddenError('Campaign creation requires an agent role');
    await assertMutation(request,session);
    const result=await createCampaign({accountId:session.accountId,userId:session.userId,role:session.role},await readBody(request));
    return NextResponse.json(result,{status:202,headers:{'Cache-Control':'no-store'}});
  }catch(error){return toErrorResponse(error);}
}
