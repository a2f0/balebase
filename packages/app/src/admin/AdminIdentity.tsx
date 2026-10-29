import { Avatar } from "@balebase/ui/react";

export function AdminIdentity({
  avatar = false,
  detail,
  name,
}: {
  avatar?: boolean;
  detail?: string | undefined;
  name: string;
}) {
  return (
    <div className="adminIdentity">
      {avatar && <Avatar name={name} size="sm" />}
      <div className="adminIdentityText">
        <span className="adminIdentityName">{name}</span>
        {detail && <span className="adminIdentityDetail">{detail}</span>}
      </div>
    </div>
  );
}
