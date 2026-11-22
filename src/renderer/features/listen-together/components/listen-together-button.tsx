import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { resyncListenTogether } from '/@/renderer/features/listen-together/hooks/use-listen-together-sync';
import {
    canHostLocally,
    isListenTogetherSupported,
    listenTogetherActions,
    useListenTogether,
} from '/@/renderer/features/listen-together/store/listen-together.store';
import { useCurrentServer, useListenTogetherSettings } from '/@/renderer/store';
import { logger } from '/@/renderer/utils/logger';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Button } from '/@/shared/components/button/button';
import { Code } from '/@/shared/components/code/code';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { Popover } from '/@/shared/components/popover/popover';
import { Stack } from '/@/shared/components/stack/stack';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';

// navigator.clipboard only exists in secure contexts (HTTPS, localhost, the desktop app)
// and can still be refused, so fall back to the legacy copy command.
const copyText = async (text: string) => {
    if (window.isSecureContext && navigator.clipboard) {
        try {
            await navigator.clipboard.writeText(text);
            return;
        } catch (error) {
            logger.warn('Listen together: clipboard API refused, using fallback', { error });
        }
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    Object.assign(textarea.style, { opacity: '0', position: 'fixed', top: '0' });
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    if (!ok) throw new Error('copy command was rejected');
};

export const ListenTogetherButton = () => {
    const { serverUrl } = useListenTogetherSettings();
    const server = useCurrentServer();

    // Needs a configured server, or the desktop app (which can host on the local network).
    if ((!serverUrl && !canHostLocally()) || !isListenTogetherSupported(server?.type)) {
        return null;
    }

    return <ListenTogetherPopover hasServer={Boolean(serverUrl)} />;
};

const ListenTogetherPopover = ({ hasServer }: { hasServer: boolean }) => {
    const { t } = useTranslation();
    const session = useListenTogether();
    const [opened, setOpened] = useState(false);
    const [code, setCode] = useState('');
    const [copied, setCopied] = useState(false);

    const handleCopy = async (value: string) => {
        try {
            await copyText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
            toast.success({ message: t('player.listenTogether_copied') });
        } catch (error) {
            logger.warn('Listen together: could not copy session code', { error });
            toast.error({ message: t('player.listenTogether_copyFailed') });
        }
    };

    const inSession = session.status !== 'idle';
    const tooltip =
        session.role === 'follower' && session.hostUsername
            ? t('player.listenTogether_following', { host: session.hostUsername })
            : t('player.listenTogether');

    return (
        <Popover onChange={setOpened} opened={opened} position="top" withArrow>
            <Popover.Target>
                <ActionIcon
                    icon="listenTogether"
                    iconProps={{
                        color: session.status === 'connected' ? 'primary' : undefined,
                        size: 'lg',
                    }}
                    onClick={(e) => {
                        e.stopPropagation();
                        setOpened((prev) => !prev);
                    }}
                    size="sm"
                    tooltip={{ label: tooltip, openDelay: 0 }}
                    variant="subtle"
                />
            </Popover.Target>
            <Popover.Dropdown maw={360} miw={300} onClick={(e) => e.stopPropagation()} p="md">
                <Stack gap="sm">
                    <Text fw={600} size="sm">
                        {t('player.listenTogether')}
                    </Text>

                    {!inSession && (
                        <>
                            <Text isMuted size="xs">
                                {t('player.listenTogether_description')}
                            </Text>
                            {hasServer && (
                                <Button
                                    onClick={listenTogetherActions.createSession}
                                    variant="filled"
                                >
                                    {t('player.listenTogether_start')}
                                </Button>
                            )}
                            {canHostLocally() && (
                                <Button
                                    onClick={listenTogetherActions.createLocalSession}
                                    variant={hasServer ? 'default' : 'filled'}
                                >
                                    {t('player.listenTogether_startLocal')}
                                </Button>
                            )}
                            <form
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    if (code.trim()) listenTogetherActions.joinSession(code);
                                }}
                            >
                                <Group gap="xs" wrap="nowrap">
                                    <TextInput
                                        autoComplete="off"
                                        onChange={(e) => setCode(e.currentTarget.value)}
                                        placeholder={t(
                                            hasServer
                                                ? 'player.listenTogether_codePlaceholder'
                                                : 'player.listenTogether_localCodePlaceholder',
                                        )}
                                        style={{ flex: 1 }}
                                        value={code}
                                    />
                                    <Button disabled={!code.trim()} type="submit" variant="default">
                                        {t('player.listenTogether_join')}
                                    </Button>
                                </Group>
                            </form>
                            <Text isMuted size="xs">
                                {t('player.listenTogether_joinWarning')}
                            </Text>
                        </>
                    )}

                    {(session.status === 'connecting' || session.status === 'reconnecting') && (
                        <Text isMuted size="sm">
                            {t(
                                session.status === 'connecting'
                                    ? 'player.listenTogether_connecting'
                                    : 'player.listenTogether_reconnecting',
                            )}
                        </Text>
                    )}

                    {session.status === 'connected' &&
                        session.role === 'host' &&
                        session.code &&
                        session.localAddresses.length > 0 && (
                            <Stack gap={4}>
                                <Text size="sm">{t('player.listenTogether_hostingLocal')}</Text>
                                {session.localAddresses.map((address) => {
                                    const joinCode = `${session.code}@${address}`;
                                    return (
                                        <Group gap={6} key={address} wrap="nowrap">
                                            <Code fz="md">{joinCode}</Code>
                                            <ActionIcon
                                                icon="clipboardCopy"
                                                onClick={() => handleCopy(joinCode)}
                                                size="sm"
                                                tooltip={{ label: t('player.listenTogether_copy') }}
                                                variant="transparent"
                                            />
                                        </Group>
                                    );
                                })}
                                <Text isMuted size="xs">
                                    {t('player.listenTogether_localFirewall')}
                                </Text>
                            </Stack>
                        )}

                    {session.status === 'connected' &&
                        session.role === 'host' &&
                        session.code &&
                        session.localAddresses.length === 0 && (
                            <Stack gap={4}>
                                <Text size="sm">{t('player.listenTogether_hosting')}</Text>
                                <Group gap={6}>
                                    <Code fz="xl">{session.code}</Code>
                                    <ActionIcon
                                        icon={copied ? 'check' : 'clipboardCopy'}
                                        onClick={() => handleCopy(session.code!)}
                                        size="sm"
                                        tooltip={{
                                            label: t(
                                                copied
                                                    ? 'player.listenTogether_copied'
                                                    : 'player.listenTogether_copy',
                                            ),
                                        }}
                                        variant="transparent"
                                    />
                                </Group>
                            </Stack>
                        )}

                    {session.status === 'connected' && session.role === 'follower' && (
                        <Text size="sm">
                            {session.hostConnected
                                ? t('player.listenTogether_following', {
                                      host: session.hostUsername,
                                  })
                                : t('player.listenTogether_hostAway')}
                        </Text>
                    )}

                    {session.status === 'connected' && session.members.length > 0 && (
                        <Stack gap={2}>
                            <Text fw={600} isMuted size="xs">
                                {t('player.listenTogether_members')}
                            </Text>
                            {session.members.map((member, i) => (
                                <Group gap={6} key={`${member.username}-${i}`}>
                                    <Icon
                                        icon={member.role === 'host' ? 'listenTogether' : 'user'}
                                    />
                                    <Text size="sm">{member.username}</Text>
                                </Group>
                            ))}
                        </Stack>
                    )}

                    {inSession && (
                        <Group gap="xs" grow>
                            {session.role === 'follower' && session.status === 'connected' && (
                                <Button onClick={resyncListenTogether} variant="default">
                                    {t('player.listenTogether_resync')}
                                </Button>
                            )}
                            <Button
                                color="red"
                                onClick={listenTogetherActions.leaveSession}
                                variant="subtle"
                            >
                                {t(
                                    session.role === 'host'
                                        ? 'player.listenTogether_end'
                                        : 'player.listenTogether_leave',
                                )}
                            </Button>
                        </Group>
                    )}
                </Stack>
            </Popover.Dropdown>
        </Popover>
    );
};
