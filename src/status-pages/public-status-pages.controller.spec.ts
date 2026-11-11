import 'reflect-metadata';
import { GUARDS_METADATA, HEADERS_METADATA } from '@nestjs/common/constants';
import { PublicStatusPagesController } from './public-status-pages.controller';
import { StatusPagesService } from './status-pages.service';

type HeaderMetadata = Array<{ name: string; value: string }>;

const headerValue = (handler: unknown, name: string): string | undefined =>
  (
    Reflect.getMetadata(HEADERS_METADATA, handler) as HeaderMetadata | undefined
  )?.find((header) => header.name === name)?.value;

describe('PublicStatusPagesController', () => {
  const page = {
    slug: 'acme',
    title: 'Acme Status',
    generatedAt: '2026-11-11T12:00:00.000Z',
    monitors: [],
  };

  let service: { getPublicPage: jest.Mock };
  let controller: PublicStatusPagesController;

  beforeEach(() => {
    service = { getPublicPage: jest.fn().mockResolvedValue(page) };
    controller = new PublicStatusPagesController(
      service as unknown as StatusPagesService,
    );
  });

  it('serves the published page without authentication', async () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, PublicStatusPagesController),
    ).toBeUndefined();

    await expect(controller.findOne('acme')).resolves.toEqual({
      success: true,
      data: page,
    });
    expect(service.getPublicPage).toHaveBeenCalledWith('acme');
  });

  it('allows any origin on this route only, and caches briefly', () => {
    // Read through the descriptor: a bare method reference would lose its
    // `this` binding (and the decorator metadata lives on the function).
    const handler = Object.getOwnPropertyDescriptor(
      PublicStatusPagesController.prototype,
      'findOne',
    )?.value as unknown;

    expect(headerValue(handler, 'Access-Control-Allow-Origin')).toBe('*');
    expect(headerValue(handler, 'Cache-Control')).toBe('public, max-age=30');
  });
});
