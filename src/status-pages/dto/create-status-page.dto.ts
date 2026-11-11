import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * Lowercase letters, digits and hyphens, 1-63 characters, no leading or
 * trailing hyphen. Short enough for a DNS label so a page can be served from a
 * subdomain later.
 */
export const STATUS_PAGE_SLUG_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const STATUS_PAGE_MAX_MONITORS = 50;
export const STATUS_PAGE_TITLE_MAX_LENGTH = 120;

const normalizeSlug = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class CreateStatusPageDto {
  @Transform(normalizeSlug)
  @IsString({ message: 'Slug must be a string' })
  @Matches(STATUS_PAGE_SLUG_PATTERN, {
    message:
      'Slug must be 1-63 lowercase letters, digits or hyphens, and cannot start or end with a hyphen',
  })
  slug!: string;

  @IsArray({ message: 'monitorIds must be an array' })
  @ArrayMinSize(1, { message: 'A status page must list at least one monitor' })
  @ArrayMaxSize(STATUS_PAGE_MAX_MONITORS, {
    message: `A status page can list at most ${STATUS_PAGE_MAX_MONITORS} monitors`,
  })
  @IsUUID('4', { each: true, message: 'monitorIds must contain monitor UUIDs' })
  monitorIds!: string[];

  @IsOptional()
  @IsBoolean({ message: 'isPublic must be a boolean' })
  isPublic?: boolean;

  @IsOptional()
  @IsString({ message: 'Title must be a string' })
  @MaxLength(STATUS_PAGE_TITLE_MAX_LENGTH, {
    message: `Title must be at most ${STATUS_PAGE_TITLE_MAX_LENGTH} characters long`,
  })
  title?: string;
}
