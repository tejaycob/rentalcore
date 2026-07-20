// src/auth/dto/register.dto.ts

import { IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export class RegisterDto {
  @IsString()
  @MinLength(2)
  companyName!: string;

  @IsIn(['MZ', 'ZA', 'AO'])
  countryCode!: 'MZ' | 'ZA' | 'AO';

  @IsString()
  currency!: string; // 'MZN' | 'ZAR' | 'AOA'

  @IsString()
  @MinLength(2)
  name!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsIn(['pt', 'en'])
  locale!: 'pt' | 'en';

  @IsOptional()
  @IsString()
  phone?: string;
}
