import { Entity, PrimaryGeneratedColumn, Column, ManyToMany, JoinTable } from 'typeorm';
import { Permission } from './permission.entity';

@Entity('roles')
export class Role {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true }) name: string;          // admin | dispatcher | hirer | technician | finance
  @Column({ nullable: true }) description: string;

  @ManyToMany(() => Permission, { eager: true })
  @JoinTable({ name: 'role_permissions',
    joinColumn: { name: 'role_id' }, inverseJoinColumn: { name: 'permission_id' } })
  permissions: Permission[];
}
