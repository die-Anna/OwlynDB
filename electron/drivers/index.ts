import type { Dialect } from '../../shared/api-types';
import type { DriverConfig, MetaDriver } from './common';
import { ElasticDriver } from './elasticsearch';
import { MysqlDriver } from './mysql';
import { MssqlDriver } from './mssql';
import { PostgresDriver } from './postgres';

export function createDriver(dialect: Dialect, cfg: DriverConfig): MetaDriver {
  switch (dialect) {
    case 'mysql':
      return new MysqlDriver(cfg);
    case 'mssql':
      return new MssqlDriver(cfg);
    case 'postgres':
      return new PostgresDriver(cfg);
    case 'elasticsearch':
      return new ElasticDriver(cfg);
  }
}

export type { DriverConfig, MetaDriver, Session } from './common';
