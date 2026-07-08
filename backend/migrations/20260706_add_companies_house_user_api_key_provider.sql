alter table user_api_keys drop constraint user_api_keys_provider_check;
alter table user_api_keys add constraint user_api_keys_provider_check
  check (provider in ('claude', 'gemini', 'openai', 'openrouter', 'companies_house'));
