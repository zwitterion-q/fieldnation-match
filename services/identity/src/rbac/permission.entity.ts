import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/**
 * Permissions are verbs on resources ('workorder:dispatch'), not screens.
 * Roles are bundles of permissions. Services check permissions, never roles --
 * so adding a role never requires touching authorisation logic downstream.
 */
@Entity('permissions')
export class Permission {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true }) name: string;
  @Column({ nullable: true }) description: string;
}
