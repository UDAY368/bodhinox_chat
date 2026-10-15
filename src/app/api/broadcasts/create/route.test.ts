import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError } from '@/lib/auth/errors';

const h=vi.hoisted(()=>({session:vi.fn(),mutation:vi.fn(),create:vi.fn()}));
vi.mock('@/lib/auth/session',()=>({requireSession:h.session,assertMutation:h.mutation}));
vi.mock('@/lib/broadcasts/create-campaign',()=>({createCampaign:h.create,CAMPAIGN_LIMITS:{bodyBytes:1024*1024}}));
import { POST } from './route';
const accountId=randomUUID(),userId=randomUUID(),id=randomUUID();
const input={name:'Campaign',templateId:randomUUID(),audience:{type:'all'},variables:{}};
const request=(body:unknown=input)=>new Request('http://localhost/api/broadcasts/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});

describe('POST /api/broadcasts/create',()=>{
  beforeEach(()=>{vi.clearAllMocks();h.session.mockResolvedValue({accountId,userId,role:'agent'});h.mutation.mockResolvedValue(undefined);h.create.mockResolvedValue({id});});
  it('uses authenticated tenant scope and returns the queued campaign identity',async()=>{
    const req=request();const response=await POST(req);
    expect(response.status).toBe(202);expect(await response.json()).toEqual({id});
    expect(h.mutation).toHaveBeenCalledWith(req,expect.objectContaining({accountId,userId}));
    expect(h.create).toHaveBeenCalledWith({accountId,userId,role:'agent'},input);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('rejects viewer identity and CSRF failure before campaign creation',async()=>{
    h.session.mockResolvedValueOnce({accountId,userId,role:'viewer'});
    expect((await POST(request())).status).toBe(403);expect(h.create).not.toHaveBeenCalled();
    h.mutation.mockRejectedValueOnce(new AuthError('Invalid CSRF proof',403));
    expect((await POST(request())).status).toBe(403);expect(h.create).not.toHaveBeenCalled();
  });
  it('bounds actual streamed input and rejects malformed JSON',async()=>{
    const malformed=new Request('http://localhost/api/broadcasts/create',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'});
    expect((await POST(malformed)).status).toBe(400);
    expect((await POST(request({extra:'x'.repeat(1024*1024)}))).status).toBe(413);
    expect(h.create).not.toHaveBeenCalled();
  });
});
