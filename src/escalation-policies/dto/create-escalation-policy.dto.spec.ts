import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateEscalationPolicyDto } from './create-escalation-policy.dto';
import { UpdateEscalationPolicyDto } from './update-escalation-policy.dto';

async function createErrors(input: Record<string, unknown>) {
  return validate(plainToInstance(CreateEscalationPolicyDto, input));
}

async function updateErrors(input: Record<string, unknown>) {
  return validate(plainToInstance(UpdateEscalationPolicyDto, input));
}

const steps = [
  { afterMinutes: 5, notifyChannelId: 'chan-1' },
  { afterMinutes: 15, notifyChannelId: 'chan-2' },
];

describe('CreateEscalationPolicyDto', () => {
  it('accepts a valid policy', async () => {
    await expect(
      createErrors({ name: 'Primary', steps }),
    ).resolves.toHaveLength(0);
  });

  it('coerces numeric strings from the wire', async () => {
    await expect(
      createErrors({
        name: 'Primary',
        steps: [{ afterMinutes: '5', notifyChannelId: 'chan-1' }],
      }),
    ).resolves.toHaveLength(0);
  });

  it('requires a name and at least one step', async () => {
    const noName = await createErrors({ steps });
    const noSteps = await createErrors({ name: 'Primary', steps: [] });

    expect(noName.length).toBeGreaterThan(0);
    expect(noSteps.length).toBeGreaterThan(0);
  });

  it('rejects non-increasing afterMinutes', async () => {
    const errors = await createErrors({
      name: 'Primary',
      steps: [
        { afterMinutes: 15, notifyChannelId: 'chan-1' },
        { afterMinutes: 5, notifyChannelId: 'chan-2' },
      ],
    });

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a step without a channel', async () => {
    const errors = await createErrors({
      name: 'Primary',
      steps: [{ afterMinutes: 5 }],
    });

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects more than ten steps', async () => {
    const errors = await createErrors({
      name: 'Primary',
      steps: Array.from({ length: 11 }, (_, i) => ({
        afterMinutes: i + 1,
        notifyChannelId: 'chan',
      })),
    });

    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('UpdateEscalationPolicyDto', () => {
  it('accepts an empty patch', async () => {
    await expect(updateErrors({})).resolves.toHaveLength(0);
  });

  it('accepts a name-only or steps-only patch', async () => {
    await expect(updateErrors({ name: 'Renamed' })).resolves.toHaveLength(0);
    await expect(updateErrors({ steps })).resolves.toHaveLength(0);
  });

  it('still validates steps when present', async () => {
    const errors = await updateErrors({
      steps: [{ afterMinutes: 0, notifyChannelId: 'chan' }],
    });

    expect(errors.length).toBeGreaterThan(0);
  });
});
