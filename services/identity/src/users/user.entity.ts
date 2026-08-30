import { Entity, PrimaryGeneratedColumn, Column, ManyToMany, JoinTable, CreateDateColumn } from 'typeorm';
import { Role } from '../rbac/role.entity';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn() id: number;

  @Column({ unique: true }) email: string;
  @Column({ name: 'password_hash' }) passwordHash: string;
  @Column({ name: 'full_name' }) fullName: string;

  /**
   * Link back to the row this account represents in the owning service.
   * identity does NOT store technician skills or buyer details -- those belong
   * to their own services. It stores only who you are and what you may do.
   */
  @Column({ name: 'subject_type', nullable: true }) subjectType: string;  // technician | hirer | null
  @Column({ name: 'subject_id', nullable: true })   subjectId: number;

  @Column({ name: 'company_name', nullable: true }) companyName: string;
  @Column({ default: true }) active: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;

  @ManyToMany(() => Role, { eager: true })
  @JoinTable({ name: 'user_roles',
    joinColumn: { name: 'user_id' }, inverseJoinColumn: { name: 'role_id' } })
  roles: Role[];
}
