import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateMonitorDto } from './create-monitor.dto';

async function errorsFor(input: Record<string, unknown>) {
  const dto = plainToInstance(CreateMonitorDto, input);
  return validate(dto);
}

describe('CreateMonitorDto', () => {
  it('accepts localhost URLs without a TLD', async () => {
    const errors = await errorsFor({
      url: 'http://localhost:5000',
      intervalSeconds: 60,
      timeoutMs: 3000,
      failureThreshold: 3,
    });

    expect(errors).toHaveLength(0);
  });

  it('accepts single-label Docker service hostnames', async () => {
    const errors = await errorsFor({
      url: 'http://api:5000/health',
      intervalSeconds: 300,
    });

    expect(errors).toHaveLength(0);
  });

  it('still rejects non-http(s) protocols and missing protocols', async () => {
    const ftp = await errorsFor({
      url: 'ftp://files.example.com/x',
      intervalSeconds: 300,
    });
    const noProtocol = await errorsFor({
      url: 'example.com/health',
      intervalSeconds: 300,
    });

    expect(ftp.length).toBeGreaterThan(0);
    expect(noProtocol.length).toBeGreaterThan(0);
  });
});
