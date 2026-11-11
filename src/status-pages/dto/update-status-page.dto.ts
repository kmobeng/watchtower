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
import {
  STATUS_PAGE_MAX_MONITORS,
  STATUS_PAGE_SLUG_PATTERN,
  STATUS_PAGE_TITLE_MAX_LENGTH,
} from './create-status-page.dto';

const normalizeSlug = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class UpdateStatusPageDto {
  @IsOptional()
  @Transform(normalizeSlug)
  @IsString({ message: 'Slug must be a string' })
  @Matches(STATUS_PAGE_SLUG_PATTERN, {
    message:
      'Slug must be 1-63 lowercase letters, digits or hyphens, and cannot start or end with a hyphen',
  })
  slug?: string;

  @IsOptional()
  @IsArray({ message: 'monitorIds must be an array' })
  @ArrayMinSize(1, { message: 'A status page must list at least one monitor' })
  @ArrayMaxSize(STATUS_PAGE_MAX_MONITORS, {
    message: `A status page can list at most ${STATUS_PAGE_MAX_MONITORS} monitors`,
  })
  @IsUUID('4', { each: true, message: 'monitorIds must contain monitor UUIDs' })
  monitorIds?: string[];

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
