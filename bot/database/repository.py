"""Database repository for CRUD operations."""

from datetime import UTC, datetime

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from bot.config import settings
from bot.database.models import Base, Conversation, ConversationFile, InviteCode, Message, User


class Repository:
    """Repository for database operations."""

    def __init__(self) -> None:
        self.engine = create_async_engine(settings.database_url, echo=False)
        self.session_factory = async_sessionmaker(self.engine, expire_on_commit=False)

    async def init_db(self) -> None:
        """Initialize the database, creating tables if needed."""
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        await self._backfill_conversation_files()

    async def _backfill_conversation_files(self) -> None:
        """Backfill conversation files from existing message attachments (idempotent)."""
        async with self.session_factory() as session:
            stmt = select(Message).where(
                (Message.image_file_id.is_not(None)) | (Message.pdf_file_id.is_not(None))
            )
            result = await session.execute(stmt)
            messages = list(result.scalars().all())

            for msg in messages:
                if msg.image_file_id:
                    await self.add_conversation_file(
                        session,
                        msg.conversation_id,
                        msg.image_file_id,
                        "image",
                    )
                if msg.pdf_file_id:
                    await self.add_conversation_file(
                        session,
                        msg.conversation_id,
                        msg.pdf_file_id,
                        "pdf",
                        file_name="document.pdf",
                    )

            await session.commit()

    async def get_or_create_user(
        self,
        session: AsyncSession,
        telegram_id: int,
        invited_by_code: str | None = None,
    ) -> User:
        """Get existing user or create a new one."""
        stmt = select(User).where(User.telegram_id == telegram_id)
        result = await session.execute(stmt)
        user = result.scalar_one_or_none()

        if user is None:
            user = User(
                telegram_id=telegram_id,
                invited_by_code=invited_by_code,
            )
            session.add(user)
            await session.flush()

        return user

    async def get_or_create_conversation(
        self,
        session: AsyncSession,
        user_id: int,
        chat_id: int,
        thread_id: int | None = None,
    ) -> Conversation:
        """Get existing conversation or create a new one."""
        stmt = select(Conversation).where(
            Conversation.chat_id == chat_id,
            Conversation.thread_id == thread_id,
        )
        result = await session.execute(stmt)
        conversation = result.scalar_one_or_none()

        if conversation is None:
            conversation = Conversation(
                user_id=user_id,
                chat_id=chat_id,
                thread_id=thread_id,
            )
            session.add(conversation)
            await session.flush()
        else:
            conversation.updated_at = datetime.now(UTC)

        return conversation

    async def add_message(
        self,
        session: AsyncSession,
        conversation_id: int,
        role: str,
        content: str,
        message_id: int | None = None,
        image_file_id: str | None = None,
        pdf_file_id: str | None = None,
    ) -> Message:
        """Add a message to a conversation."""
        message = Message(
            conversation_id=conversation_id,
            role=role,
            content=content,
            message_id=message_id,
            image_file_id=image_file_id,
            pdf_file_id=pdf_file_id,
        )
        session.add(message)
        await session.flush()
        return message

    async def get_conversation_file(
        self,
        session: AsyncSession,
        conversation_id: int,
        file_id: str,
        file_type: str,
    ) -> ConversationFile | None:
        """Get a conversation file by file_id and type."""
        stmt = select(ConversationFile).where(
            ConversationFile.conversation_id == conversation_id,
            ConversationFile.file_id == file_id,
            ConversationFile.file_type == file_type,
        )
        result = await session.execute(stmt)
        return result.scalar_one_or_none()

    async def add_conversation_file(
        self,
        session: AsyncSession,
        conversation_id: int,
        file_id: str,
        file_type: str,
        file_name: str | None = None,
        text_content: str | None = None,
    ) -> tuple[ConversationFile, bool]:
        """Add a file to a conversation, return (file, created)."""
        existing = await self.get_conversation_file(
            session, conversation_id, file_id, file_type
        )
        if existing:
            return existing, False

        conversation_file = ConversationFile(
            conversation_id=conversation_id,
            file_id=file_id,
            file_type=file_type,
            file_name=file_name,
            text_content=text_content,
        )
        session.add(conversation_file)
        await session.flush()
        return conversation_file, True

    async def get_conversation_files(
        self,
        session: AsyncSession,
        conversation_id: int,
        file_type: str | None = None,
    ) -> list[ConversationFile]:
        """Get all conversation files, optionally filtered by type."""
        stmt = select(ConversationFile).where(ConversationFile.conversation_id == conversation_id)
        if file_type:
            stmt = stmt.where(ConversationFile.file_type == file_type)
        result = await session.execute(stmt.order_by(ConversationFile.created_at))
        return list(result.scalars().all())


    async def get_conversation_messages(
        self,
        session: AsyncSession,
        conversation_id: int,
    ) -> list[Message]:
        """Get all messages for a conversation."""
        stmt = (
            select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.created_at)
        )
        result = await session.execute(stmt)
        return list(result.scalars().all())

    async def get_user_by_telegram_id(
        self,
        session: AsyncSession,
        telegram_id: int,
    ) -> User | None:
        """Get user by Telegram ID."""
        stmt = select(User).where(User.telegram_id == telegram_id)
        result = await session.execute(stmt)
        return result.scalar_one_or_none()

    async def toggle_show_thinking(
        self,
        session: AsyncSession,
        telegram_id: int,
    ) -> bool:
        """Toggle show_thinking for a user and return new value."""
        user = await self.get_user_by_telegram_id(session, telegram_id)
        if user:
            user.show_thinking = not user.show_thinking
            return user.show_thinking
        return False

    async def update_user_language(
        self,
        session: AsyncSession,
        telegram_id: int,
        language: str,
    ) -> None:
        """Update user's language preference."""
        user = await self.get_user_by_telegram_id(session, telegram_id)
        if user:
            user.language = language

    async def get_user_language(
        self,
        session: AsyncSession,
        telegram_id: int,
    ) -> str:
        """Get user's language preference, defaults to 'en'."""
        user = await self.get_user_by_telegram_id(session, telegram_id)
        return user.language if user else "en"

    async def update_user_timezone(
        self,
        session: AsyncSession,
        telegram_id: int,
        offset_minutes: int,
    ) -> None:
        """Update user's timezone offset in minutes from UTC."""
        user = await self.get_user_by_telegram_id(session, telegram_id)
        if user:
            user.timezone_offset = offset_minutes

    async def get_user_timezone(
        self,
        session: AsyncSession,
        telegram_id: int,
    ) -> int:
        """Get user's timezone offset in minutes, defaults to 0 (UTC)."""
        user = await self.get_user_by_telegram_id(session, telegram_id)
        return user.timezone_offset if user else 0

    async def _get_latest_message_by_role(
        self,
        session: AsyncSession,
        conversation_id: int,
        role: str,
    ) -> Message | None:
        """Get the most recent message with the specified role."""
        stmt = (
            select(Message)
            .where(Message.conversation_id == conversation_id, Message.role == role)
            .order_by(desc(Message.created_at))
            .limit(1)
        )
        result = await session.execute(stmt)
        return result.scalar_one_or_none()

    async def get_latest_assistant_response(
        self,
        session: AsyncSession,
        conversation_id: int,
    ) -> Message | None:
        """Get the latest assistant message."""
        return await self._get_latest_message_by_role(session, conversation_id, "assistant")

    async def get_latest_user_message(
        self,
        session: AsyncSession,
        conversation_id: int,
    ) -> Message | None:
        """Get most recent user message."""
        return await self._get_latest_message_by_role(session, conversation_id, "user")

    async def delete_latest_assistant_response(
        self,
        session: AsyncSession,
        conversation_id: int,
    ) -> int | None:
        """Delete latest assistant message, return its Telegram message_id."""
        message = await self.get_latest_assistant_response(session, conversation_id)
        if not message:
            return None

        telegram_id = message.message_id
        await session.delete(message)
        return telegram_id

    async def create_invite_code(
        self,
        session: AsyncSession,
        code: str,
        created_by: int,
        max_uses: int | None = None,
    ) -> InviteCode:
        """Create a new invite code."""
        invite = InviteCode(
            code=code,
            created_by=created_by,
            max_uses=max_uses,
        )
        session.add(invite)
        await session.flush()
        return invite

    async def get_invite_code(
        self,
        session: AsyncSession,
        code: str,
    ) -> InviteCode | None:
        """Get active invite code by string."""
        stmt = select(InviteCode).where(
            InviteCode.code == code,
            InviteCode.is_active.is_(True),
        )
        result = await session.execute(stmt)
        return result.scalar_one_or_none()

    async def get_all_invite_codes(
        self,
        session: AsyncSession,
    ) -> list[InviteCode]:
        """List all active invite codes."""
        stmt = (
            select(InviteCode)
            .where(InviteCode.is_active.is_(True))
            .order_by(desc(InviteCode.created_at))
        )
        result = await session.execute(stmt)
        return list(result.scalars().all())

    async def use_invite_code(
        self,
        session: AsyncSession,
        code: str,
    ) -> bool:
        """Increment usage counter, return True if successful."""
        invite = await self.get_invite_code(session, code)
        if not invite:
            return False

        # Check if max uses reached
        if invite.max_uses is not None and invite.current_uses >= invite.max_uses:
            return False

        invite.current_uses += 1
        return True

    async def add_invite_uses(
        self,
        session: AsyncSession,
        code: str,
        additional_uses: int = 1,
    ) -> bool:
        """Add additional uses to an existing invite code."""
        invite = await self.get_invite_code(session, code)
        if not invite:
            return False

        if invite.max_uses is None:
            return True  # Already unlimited

        invite.max_uses += additional_uses
        return True

    async def delete_invite_code(
        self,
        session: AsyncSession,
        code: str,
    ) -> bool:
        """Soft-delete an invite code, return True if found."""
        invite = await self.get_invite_code(session, code)
        if not invite:
            return False

        invite.is_active = False
        return True

    async def create_user_by_id(
        self,
        session: AsyncSession,
        telegram_id: int,
    ) -> User:
        """Pre-approve user by telegram ID (creates user record)."""
        # Check if user already exists
        existing = await self.get_user_by_telegram_id(session, telegram_id)
        if existing:
            return existing

        user = User(telegram_id=telegram_id)
        session.add(user)
        await session.flush()
        return user


repository = Repository()
