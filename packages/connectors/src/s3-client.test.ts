import {describe, it, expect} from 'vitest';
import {MinioHttpObjectClient} from './s3-client.js';

describe('MinIO HTTP object client', () => {
  it('signs metadata-only list requests and parses object keys', async () => {
    let request = {url: '', headers: {} as Record<string, string>};
    const client = new MinioHttpObjectClient({endpoint: 'http://minio:9000', accessKey: 'demo', secretKey: 'secret', fetcher: async (url, init) => { request = {url, headers: init.headers}; return {ok: true, status: 200, text: async () => '<ListBucketResult><Key>CUST-1042/profile.txt</Key><Key>CUST-1042/id.txt</Key></ListBucketResult>'}; }});
    await expect(client.list('customer-uploads', 'CUST-1042/')).resolves.toEqual(['CUST-1042/profile.txt', 'CUST-1042/id.txt']);
    expect(request.url).toContain('list-type=2'); expect(request.url).toContain('prefix=CUST-1042%2F'); expect(request.headers.authorization).toContain('AWS4-HMAC-SHA256'); expect(request.headers['x-amz-content-sha256']).toHaveLength(64); expect(request.headers).not.toHaveProperty('x-api-key');
  });
  it('rejects malformed copy and delete object identities', async () => { const client = new MinioHttpObjectClient({endpoint: 'http://minio:9000', accessKey: 'demo', secretKey: 'secret', fetcher: async () => ({ok: true, status: 200, text: async () => ''})}); await expect(client.copy('malformed', 'bucket/key')).rejects.toThrow('copy source'); await expect(client.delete('malformed')).rejects.toThrow('object key'); });
  it('writes backup artifacts with signed JSON PUT requests', async () => { let request: {method:string;url:string;body?:string}|undefined; const client = new MinioHttpObjectClient({endpoint: 'http://minio:9000', accessKey: 'demo', secretKey: 'secret', fetcher: async (url, init) => { request = {method: init.method, url, body: init.body}; return {ok: true, status: 200, text: async () => ''}; }}); await client.put('eraseops-backups', 'request-1/database.json', '{"safe":true}'); expect(request).toMatchObject({method:'PUT',body:'{"safe":true}'}); expect(request?.url).toContain('eraseops-backups/request-1/database.json'); });
});
