import { Controller, Get, Header, Param } from '@nestjs/common';
import { StatusPagesService } from './status-pages.service';

/**
 * The unauthenticated read that external sites embed.
 *
 * `Access-Control-Allow-Origin: *` is set here rather than globally: the rest
 * of the API has no CORS layer, and enabling one app-wide would change the
 * security posture of every authenticated route. This handler is a plain GET
 * with no custom request headers, so it is a CORS "simple request" and needs
 * no preflight.
 */
@Controller('status-pages')
export class PublicStatusPagesController {
  constructor(private readonly statusPages: StatusPagesService) {}

  @Get(':slug')
  @Header('Access-Control-Allow-Origin', '*')
  @Header('Cache-Control', 'public, max-age=30')
  async findOne(@Param('slug') slug: string) {
    const page = await this.statusPages.getPublicPage(slug);
    return { success: true, data: page };
  }
}
