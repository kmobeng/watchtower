import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListMonitorsDto } from './list-monitors.dto';

async function errorsFor(input: Record<string, unknown>) {
  const dto = plainToInstance(ListMonitorsDto, input);
  return validate(dto);
}

describe('ListMonitorsDto', () => {
  it('passes with no query params (controller applies defaults)', async () => {
    expect(await errorsFor({})).toHaveLength(0);
  });

  it('coerces string query params to numbers', async () => {
    const dto = plainToInstance(ListMonitorsDto, { page: '2', limit: '10' });
    expect(dto.page).toBe(2);
    expect(dto.limit).toBe(10);
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects limit above the max', async () => {
    const errors = await errorsFor({ limit: 101 });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects page below 1', async () => {
    const errors = await errorsFor({ page: 0 });
    expect(errors.length).toBeGreaterThan(0);
  });
});
