import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export type ObjectStorage = {
  put(key: string, body: string | Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
};

export class MemoryObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, Buffer>();

  async put(key: string, body: string | Buffer, _contentType: string): Promise<void> {
    this.objects.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body));
  }

  async get(key: string): Promise<Buffer | null> {
    return this.objects.get(key) ?? null;
  }
}

export class R2ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    endpoint: string,
    accessKeyId: string,
    secretAccessKey: string,
  ) {
    this.client = new S3Client({
      region: "auto",
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async put(key: string, body: string | Buffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }));
  }

  async get(key: string): Promise<Buffer | null> {
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
    const chunks: Buffer[] = [];
    const body = response.Body;
    if (!body || typeof body === "string") return null;
    for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}
