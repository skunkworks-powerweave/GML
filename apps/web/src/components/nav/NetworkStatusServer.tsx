// The connection indicator with its six strings translated, for either shell.
//
// NetworkStatus is a client island (it probes /api/ping), so its labels come
// in as props; this server component is the one place they are looked up, so
// the desktop sidebar and the phone header cannot drift apart. The phone
// header had no indicator at all until this existed -- see NetworkStatus's
// `variant`.

import { getTranslations } from "next-intl/server";
import { NetworkStatus } from "./NetworkStatus";

export async function NetworkStatusServer({ variant }: { variant: "sidebar" | "compact" }) {
  const tStatus = await getTranslations("status");
  return (
    <NetworkStatus
      variant={variant}
      labelOnline={tStatus("online")}
      labelOffline={tStatus("offline")}
      labelChecking={tStatus("checking")}
      hintOnline={tStatus("onlineHint")}
      hintOffline={tStatus("offlineHint")}
      hintChecking={tStatus("checkingHint")}
    />
  );
}
