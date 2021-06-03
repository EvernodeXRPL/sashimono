#include "comm_session.hpp"
#include "../util/util.hpp"

namespace comm
{
    constexpr uint16_t MAX_IN_MSG_QUEUE_SIZE = 64; // Maximum in message queue size, The size passed is rounded to next number in binary sequence 1(1),11(3),111(7),1111(15),11111(31)....

    comm_session::comm_session(
        std::string_view host_address, hpws::client &&hpws_client)
        : uniqueid(host_address),
          host_address(host_address),
          hpws_client(std::move(hpws_client)),
          msg_parser(std::move(msg::msg_parser())),
          in_msg_queue(MAX_IN_MSG_QUEUE_SIZE)
    {
    }

    /**
     * Init() should be called to activate the session.
     * Because we are starting threads here, after init() is called, the session object must not be "std::moved".
     * @return returns 0 on successful init, otherwise -1;
     */
    int comm_session::init()
    {
        if (state == SESSION_STATE::NONE)
        {
            reader_thread = std::thread(&comm_session::reader_loop, this);
            writer_thread = std::thread(&comm_session::process_outbound_msg_queue, this);
            state = SESSION_STATE::ACTIVE;

            // Send an initial message to the host.
            std::string res;
            msg_parser.create_response(res, msg::MSGTYPE_INIT, "Connection initiated.");
            send(res);
            LOG_DEBUG << "Session started: " << uniqueid;
        }

        return 0;
    }

    /**
     * Listening for receiving messages and process them.
     */
    void comm_session::reader_loop()
    {
        util::mask_signal();

        while (state != SESSION_STATE::CLOSED && hpws_client)
        {
            const std::variant<std::string_view, hpws::error> read_result = hpws_client->read();
            if (std::holds_alternative<hpws::error>(read_result))
            {
                const hpws::error error = std::get<hpws::error>(read_result);
                if (error.first != 1) // 1 indicates channel has closed.
                    LOG_ERROR << "hpws client read failed:" << error.first << " " << error.second;
            }
            else
            {
                // Enqueue the message for processing.
                std::string_view data = std::get<std::string_view>(read_result);
                in_msg_queue.try_enqueue(std::string(data));

                // Signal the hpws client that we are ready for next message.
                const std::optional<hpws::error> error = hpws_client->ack(data);
                if (error.has_value())
                    LOG_ERROR << "hpws client ack failed:" << error->first << " " << error->second;
            }
        }
    }

    /**
     * Processes the next queued message (if any).
     * @return 0 if no messages in queue. 1 if a message were processed. -1 error occured
     */
    int comm_session::process_next_inbound_message()
    {
        if (state != SESSION_STATE::ACTIVE)
            return 0;

        int res = 0;

        // Process queue top.
        std::string msg;
        if (in_msg_queue.try_dequeue(msg))
        {
            if (handle_message(msg) == -1)
                return -1;
            else
                res = 1;
        }

        return res;
    }

    /**
     * This function constructs and sends the message to the target from the given message.
     * @param message Message to be sent via the pipe.
     * @return 0 on successful message sent and -1 on error.
    */
    int comm_session::process_outbound_message(std::string_view message)
    {
        if (state == SESSION_STATE::CLOSED || !hpws_client)
            return -1;

        const std::optional<hpws::error> error = hpws_client->write(message);
        if (error.has_value())
        {
            LOG_ERROR << "hpws client write failed:" << error->first << " " << error->second;
            return -1;
        }
        return 0;
    }

    /**
     * Process message sending in the queue in the outbound_queue_thread.
    */
    void comm_session::process_outbound_msg_queue()
    {
        // Appling a signal mask to prevent receiving control signals from linux kernel.
        util::mask_signal();

        // Keep checking until the session is terminated.
        while (state != SESSION_STATE::CLOSED)
        {
            bool messages_sent = false;
            std::string msg_to_send;

            // Send all messages in queue.
            while (out_msg_queue.try_dequeue(msg_to_send))
            {
                process_outbound_message(msg_to_send);
                msg_to_send.clear();
                messages_sent = true;
            }

            // Wait for small delay if there were no outbound messages.
            if (!messages_sent)
                util::sleep(10);
        }
    }

    /**
     * Handles the received message.
     * @param msg Received message.
     * @return 0 on success -1 on error.
    */
    int comm_session::handle_message(std::string_view msg)
    {
        std::string type;
        std::string id;
        if (msg_parser.parse(msg) == -1 || msg_parser.extract_type(type) == -1)
            return -1;

        if (type == msg::MSGTYPE_CREATE)
        {
            msg::create_msg msg;
            if (msg_parser.extract_create_message(msg) == -1)
                return -1;
            id = msg.id;
            LOG_INFO << "---------------Create signal received--------------";
            LOG_INFO << "---------------Pubkey: " << msg.pubkey << "--------------";
        }
        else if (type == msg::MSGTYPE_DESTROY)
        {
            msg::destroy_msg msg;
            if (msg_parser.extract_destroy_message(msg))
                return -1;
            id = msg.id;
            LOG_INFO << "---------------Destroy signal received--------------";
            LOG_INFO << "---------------Pubkey: " << msg.pubkey << ", ContractId: " << msg.contract_id << "--------------";
        }
        else if (type == msg::MSGTYPE_START)
        {
            msg::start_msg msg;
            if (msg_parser.extract_start_message(msg))
                return -1;
            id = msg.id;
            LOG_INFO << "---------------Start signal received--------------";
            LOG_INFO << "---------------Pubkey: " << msg.pubkey << ", ContractId: " << msg.contract_id << "--------------";
        }
        else if (type == msg::MSGTYPE_STOP)
        {
            msg::stop_msg msg;
            if (msg_parser.extract_stop_message(msg))
                return -1;
            id = msg.id;
            LOG_INFO << "---------------Stop signal received--------------";
            LOG_INFO << "---------------Pubkey: " << msg.pubkey << ", ContractId: " << msg.contract_id << "--------------";
        }
        else
        {
            LOG_ERROR << "Received invalid message type.";
            return -1;
        }

        std::string res;
        msg_parser.create_response(res, type, "Acknowledgment for message " + id);
        send(res);
        return 0;
    }

    /**
     * Adds the given message to the outbound message queue.
     * @param message Message to be added to the outbound queue.
     * @return 0 on successful addition and -1 if the session is already closed.
    */
    int comm_session::send(std::string_view message)
    {
        if (state == SESSION_STATE::CLOSED)
            return -1;

        // Passing the ownership of message to the queue.
        out_msg_queue.enqueue(std::string(message));

        return 0;
    }

    /**
     * Close the connection and wrap up any session processing threads.
     * This will be only called by the global comm_handler.
     */
    void comm_session::close()
    {
        if (state == SESSION_STATE::CLOSED)
            return;

        state = SESSION_STATE::CLOSED;

        // Destruct the hpws client instance so it will close the sockets and related processes.
        hpws_client.reset();

        // Wait untill reader/writer threads gracefully stop.
        if (writer_thread.joinable())
            writer_thread.join();

        if (reader_thread.joinable())
            reader_thread.join();

        LOG_DEBUG << "Session closed: " << uniqueid;
    }

} // namespace comm